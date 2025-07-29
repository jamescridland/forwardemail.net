/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const Boom = require('@hapi/boom');
const dayjs = require('dayjs-with-plugins');
const isSANB = require('is-string-and-not-blank');

const { EnterpriseAccounts, Payments, Users, Domains } = require('#models');
const config = require('#config');

async function retrieve(ctx) {
  // Get enterprise account by ID
  const enterpriseAccount = await EnterpriseAccounts.findById(ctx.params.id)
    .populate('user', 'email plan created_at has_verified_email is_banned')
    .lean()
    .exec();

  if (!enterpriseAccount) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  // Get user's domains
  const domains = await Domains.find({
    'members.user': enterpriseAccount.user._id
  })
    .select(
      'name plan max_recipients_per_alias storage_used storage_quota created_at'
    )
    .lean()
    .exec();

  // Get payment history
  const payments = await Payments.find({
    user: enterpriseAccount.user._id
  })
    .sort({ created_at: -1 })
    .limit(10)
    .lean()
    .exec();

  // Calculate payment statistics
  const totalPaid = payments.reduce(
    (sum, payment) => sum + (payment.amount || 0),
    0
  );
  const lastPayment = payments.length > 0 ? payments[0] : null;

  // Calculate next payment date
  let nextPaymentDate = null;
  if (enterpriseAccount.payment_info?.next_billing_date) {
    nextPaymentDate = enterpriseAccount.payment_info.next_billing_date;
  } else if (lastPayment && enterpriseAccount.payment_info?.billing_cycle) {
    const lastPaymentDate = new Date(lastPayment.created_at);
    switch (enterpriseAccount.payment_info.billing_cycle) {
      case 'monthly': {
        nextPaymentDate = new Date(
          lastPaymentDate.setMonth(lastPaymentDate.getMonth() + 1)
        );
        break;
      }

      case 'quarterly': {
        nextPaymentDate = new Date(
          lastPaymentDate.setMonth(lastPaymentDate.getMonth() + 3)
        );
        break;
      }

      case 'annual': {
        nextPaymentDate = new Date(
          lastPaymentDate.setFullYear(lastPaymentDate.getFullYear() + 1)
        );
        break;
      }
    }
  }

  // Get renewal alerts (contracts expiring within 90 days)
  const renewalAlerts = [];
  if (enterpriseAccount.contract?.renewal_date) {
    const renewalDate = new Date(enterpriseAccount.contract.renewal_date);
    const ninetyDaysFromNow = new Date();
    ninetyDaysFromNow.setDate(ninetyDaysFromNow.getDate() + 90);

    if (renewalDate <= ninetyDaysFromNow) {
      const daysUntilRenewal = Math.ceil(
        (renewalDate - Date.now()) / (1000 * 60 * 60 * 24)
      );
      renewalAlerts.push({
        type: 'contract_renewal',
        message: `Contract renewal due in ${daysUntilRenewal} days`,
        date: renewalDate,
        urgency: daysUntilRenewal <= 30 ? 'high' : 'medium'
      });
    }
  }

  // Check for overdue payments
  if (nextPaymentDate && nextPaymentDate < new Date()) {
    const daysOverdue = Math.ceil(
      (Date.now() - nextPaymentDate) / (1000 * 60 * 60 * 24)
    );
    renewalAlerts.push({
      type: 'payment_overdue',
      message: `Payment overdue by ${daysOverdue} days`,
      date: nextPaymentDate,
      urgency: 'high'
    });
  }

  // Group documents by type
  const documentsByType = {};
  if (enterpriseAccount.documents) {
    for (const doc of enterpriseAccount.documents) {
      if (!documentsByType[doc.type]) {
        documentsByType[doc.type] = [];
      }

      documentsByType[doc.type].push(doc);
    }
  }

  // Calculate onboarding progress
  const onboardingSteps = [
    'inquiry_received',
    'discovery_in_progress',
    'proposal_sent',
    'proposal_under_review',
    'contract_negotiation',
    'contract_ready_for_review',
    'contract_sent_for_signature',
    'contract_signed',
    'payment_pending',
    'payment_received',
    'account_setup',
    'completed'
  ];

  const currentStepIndex = onboardingSteps.indexOf(
    enterpriseAccount.onboarding_status
  );
  const onboardingProgress =
    currentStepIndex >= 0
      ? Math.round(((currentStepIndex + 1) / onboardingSteps.length) * 100)
      : 0;

  ctx.state.enterpriseAccount = enterpriseAccount;
  ctx.state.domains = domains;
  ctx.state.payments = payments;
  ctx.state.totalPaid = totalPaid;
  ctx.state.lastPayment = lastPayment;
  ctx.state.nextPaymentDate = nextPaymentDate;
  ctx.state.renewalAlerts = renewalAlerts;
  ctx.state.documentsByType = documentsByType;
  ctx.state.onboardingProgress = onboardingProgress;

  if (ctx.accepts('html')) {
    return ctx.render('admin/enterprise/account');
  }

  ctx.body = {
    enterpriseAccount,
    domains,
    payments,
    totalPaid,
    lastPayment,
    nextPaymentDate,
    renewalAlerts,
    documentsByType,
    onboardingProgress
  };
}

async function update(ctx) {
  const enterpriseAccount = await EnterpriseAccounts.findById(ctx.params.id);

  if (!enterpriseAccount) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  const originalStatus = enterpriseAccount.onboarding_status;

  // Update allowed fields
  const allowedFields = [
    'company_name',
    'company_size',
    'industry',
    'website',
    'address',
    'primary_contact',
    'technical_contact',
    'billing_contact',
    'requirements',
    'onboarding_status',
    'contract',
    'payment_info',
    'account_manager',
    'is_priority_account'
  ];

  for (const field of allowedFields) {
    if (ctx.request.body[field] !== undefined) {
      enterpriseAccount[field] = ctx.request.body[field];
    }
  }

  // Add timeline entry if status changed
  if (
    ctx.request.body.onboarding_status &&
    ctx.request.body.onboarding_status !== originalStatus
  ) {
    await enterpriseAccount.addTimelineEntry(
      ctx.request.body.onboarding_status,
      ctx.request.body.status_notes ||
        `Status updated to ${ctx.request.body.onboarding_status}`,
      ctx.state.user.email
    );

    // Trigger automated actions for status changes
    await triggerAutomatedActions(
      enterpriseAccount,
      ctx.request.body.onboarding_status
    );
  } else {
    await enterpriseAccount.save();
  }

  if (ctx.accepts('html')) {
    ctx.flash('success', ctx.translate('ENTERPRISE_ACCOUNT_UPDATED'));
    return ctx.redirect('back');
  }

  ctx.body = { message: ctx.translate('ENTERPRISE_ACCOUNT_UPDATED') };
}

async function addNote(ctx) {
  const enterpriseAccount = await EnterpriseAccounts.findById(ctx.params.id);

  if (!enterpriseAccount) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  if (!isSANB(ctx.request.body.content)) {
    return ctx.throw(
      Boom.badRequest(ctx.translateError('NOTE_CONTENT_REQUIRED'))
    );
  }

  enterpriseAccount.notes.push({
    content: ctx.request.body.content,
    created_by: ctx.state.user.email,
    type: ctx.request.body.type || 'general'
  });

  await enterpriseAccount.save();

  if (ctx.accepts('html')) {
    ctx.flash('success', ctx.translate('NOTE_ADDED'));
    return ctx.redirect('back');
  }

  ctx.body = { message: ctx.translate('NOTE_ADDED') };
}

async function uploadDocument(ctx) {
  const enterpriseAccount = await EnterpriseAccounts.findById(ctx.params.id);

  if (!enterpriseAccount) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  // This would integrate with your file upload system
  // For now, we'll just add document metadata
  const documentData = {
    name: ctx.request.body.name,
    type: ctx.request.body.type,
    url: ctx.request.body.url, // This would be the uploaded file URL
    uploaded_by: ctx.state.user.email,
    version: ctx.request.body.version || '1.0',
    status: ctx.request.body.status || 'draft'
  };

  enterpriseAccount.documents.push(documentData);
  await enterpriseAccount.save();

  if (ctx.accepts('html')) {
    ctx.flash('success', ctx.translate('DOCUMENT_UPLOADED'));
    return ctx.redirect('back');
  }

  ctx.body = { message: ctx.translate('DOCUMENT_UPLOADED') };
}

// Generate enterprise account setup document
async function generateSetupDocument(ctx) {
  const enterpriseAccount = await EnterpriseAccounts.findById(ctx.params.id)
    .populate('user', 'email')
    .lean()
    .exec();

  if (!enterpriseAccount) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  // This would integrate with your document generation system
  // For now, we'll create a mock document structure
  const documentData = {
    name: `Enterprise Setup Guide - ${enterpriseAccount.company_name}`,
    type: 'setup_guide',
    content: {
      company: enterpriseAccount.company_name,
      contact: enterpriseAccount.primary_contact,
      requirements: enterpriseAccount.requirements,
      generatedAt: new Date(),
      generatedBy: ctx.state.user.email
    }
  };

  // Add to documents array
  enterpriseAccount.documents = enterpriseAccount.documents || [];
  enterpriseAccount.documents.push({
    name: documentData.name,
    type: documentData.type,
    url: `/documents/setup/${enterpriseAccount._id}`, // Mock URL
    uploaded_by: ctx.state.user.email,
    status: 'approved'
  });

  await EnterpriseAccounts.findByIdAndUpdate(enterpriseAccount._id, {
    documents: enterpriseAccount.documents
  });

  if (ctx.accepts('html')) {
    ctx.flash('success', ctx.translate('SETUP_DOCUMENT_GENERATED'));
    return ctx.redirect('back');
  }

  ctx.body = {
    message: ctx.translate('SETUP_DOCUMENT_GENERATED'),
    document: documentData
  };
}

// Trigger specific workflow action
async function triggerWorkflowAction(ctx) {
  const enterpriseAccount = await EnterpriseAccounts.findById(ctx.params.id);

  if (!enterpriseAccount) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  const { action, notes } = ctx.request.body;

  if (!isSANB(action)) {
    return ctx.throw(Boom.badRequest(ctx.translateError('ACTION_REQUIRED')));
  }

  let statusUpdate = null;
  let successMessage = 'Workflow action completed';

  switch (action) {
    case 'send_proposal': {
      statusUpdate = 'proposal_sent';
      successMessage = 'Proposal sent to client';
      break;
    }

    case 'generate_contract': {
      // Generate contract document
      await generateContractDocument(enterpriseAccount, ctx.state.user.email);
      statusUpdate = 'contract_ready_for_review';
      successMessage = 'Contract document generated and ready for admin review';
      break;
    }

    case 'approve_contract': {
      // Approve contract for sending (no status change, just approval flag)
      await approveContractForSignature(enterpriseAccount, ctx.state.user.email, notes);
      successMessage = 'Contract approved and ready to send for signature';
      // Don't change status - stays at contract_ready_for_review until actually sent
      break;
    }

    case 'send_for_signature': {
      // Send contract for DocuSign signature
      await sendContractForSignature(enterpriseAccount, ctx.state.user.email);
      statusUpdate = 'contract_sent_for_signature';
      successMessage = 'Contract sent for signature via DocuSign';
      break;
    }

    case 'initiate_contract': {
      statusUpdate = 'contract_negotiation';
      successMessage = 'Contract negotiation initiated';
      break;
    }

    case 'setup_account': {
      statusUpdate = 'account_setup';
      successMessage = 'Account setup process started';
      break;
    }

    case 'complete_onboarding': {
      statusUpdate = 'completed';
      successMessage = 'Onboarding completed successfully';
      break;
    }

    default: {
      return ctx.throw(Boom.badRequest(ctx.translateError('INVALID_ACTION')));
    }
  }

  if (statusUpdate) {
    await enterpriseAccount.addTimelineEntry(
      statusUpdate,
      notes || successMessage,
      ctx.state.user.email
    );

    // Trigger automated actions
    await triggerAutomatedActions(enterpriseAccount, statusUpdate);
  }

  if (ctx.accepts('html')) {
    ctx.flash('success', ctx.translate('WORKFLOW_ACTION_COMPLETED'));
    return ctx.redirect('back');
  }

  ctx.body = {
    message: ctx.translate('WORKFLOW_ACTION_COMPLETED'),
    newStatus: statusUpdate
  };
}

// Helper function to trigger automated actions
async function triggerAutomatedActions(account, status) {
  const { Users } = require('#models');

  switch (status) {
    case 'contract_signed': {
      // Auto-update user to enterprise plan
      await Users.findByIdAndUpdate(account.user, {
        plan: 'enterprise',
        plan_set_at: new Date()
      });
      break;
    }

    case 'payment_received': {
      // Update payment info and calculate next billing
      account.payment_info.last_payment_date = new Date();
      account.payment_info.next_billing_date =
        account.calculateNextBillingDate();
      await account.save();
      break;
    }

    case 'account_setup': {
      // Generate setup documentation
      // This would trigger document generation
      break;
    }

    case 'completed': {
      // Set success metrics
      account.success_metrics.onboarding_completion_date = new Date();
      account.success_metrics.user_adoption_rate = 100;
      await account.save();
      break;
    }
  }
}

// Generate contract document
async function generateContractDocument(enterpriseAccount, adminEmail) {
  const { EnterpriseAccounts } = require('#models');
  
  // Create contract document entry
  const contractDocument = {
    name: `Enterprise Service Agreement - ${enterpriseAccount.company_name}`,
    type: 'contract',
    url: `/documents/contracts/${enterpriseAccount._id}/enterprise-agreement.pdf`, // Generated PDF path
    uploaded_by: adminEmail,
    status: 'draft',
    version: '1.0'
  };

  // Add document to enterprise account
  await EnterpriseAccounts.findByIdAndUpdate(
    enterpriseAccount._id,
    { $push: { documents: contractDocument } }
  );

  // In a real implementation, this would generate an actual PDF using libraries like:
  // - puppeteer (HTML to PDF)
  // - jsPDF
  // - pdfkit
  // - External service like DocRaptor or PDFShift
  
  console.log(`Contract document generated for ${enterpriseAccount.company_name}`);
}

// Approve contract for signature
async function approveContractForSignature(enterpriseAccount, adminEmail, approvalNotes) {
  const { EnterpriseAccounts } = require('#models');
  
  // Find the most recent contract document
  const contractDoc = enterpriseAccount.documents
    .filter(doc => doc.type === 'contract')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

  if (!contractDoc) {
    throw new Error('No contract document found. Please generate contract first.');
  }

  // Update document with approval information
  await EnterpriseAccounts.findOneAndUpdate(
    { _id: enterpriseAccount._id, 'documents._id': contractDoc._id },
    {
      $set: {
        'documents.$.approved_by': adminEmail,
        'documents.$.approved_at': new Date(),
        'documents.$.approval_notes': approvalNotes || 'Contract approved for signature',
        'documents.$.status': 'approved'
      }
    }
  );

  console.log(`Contract approved by ${adminEmail} for ${enterpriseAccount.company_name}`);
}

// Send contract for signature via DocuSign
async function sendContractForSignature(enterpriseAccount, adminEmail) {
  const { EnterpriseAccounts } = require('#models');
  
  // Find the most recent contract document
  const contractDoc = enterpriseAccount.documents
    .filter(doc => doc.type === 'contract')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

  if (!contractDoc) {
    throw new Error('No contract document found. Please generate contract first.');
  }

  // Check if contract has been approved
  if (contractDoc.status !== 'approved') {
    throw new Error('Contract must be approved before sending for signature. Please use "Approve Contract for Signature" action first.');
  }

  // Import signature controller functions
  const { initiateSignature } = require('./enterprise-signatures');
  
  try {
    // Create mock request context for signature initiation
    const mockCtx = {
      params: { id: enterpriseAccount._id.toString() },
      request: {
        body: {
          documentId: contractDoc._id.toString(),
          signerEmail: enterpriseAccount.primary_contact.email,
          signerName: enterpriseAccount.primary_contact.name,
          provider: 'docusign'
        }
      },
      state: { user: { email: adminEmail } },
      translateError: (key) => key,
      translate: (key) => key,
      flash: () => {},
      redirect: () => {},
      accepts: () => false
    };

    // Initiate signature process
    await initiateSignature(mockCtx);
    
    console.log(`Contract sent for signature to ${enterpriseAccount.primary_contact.email}`);
  } catch (error) {
    console.error('Failed to send contract for signature:', error.message);
    throw error;
  }
}

module.exports = {
  retrieve,
  update,
  addNote,
  uploadDocument,
  generateSetupDocument,
  triggerWorkflowAction
};
