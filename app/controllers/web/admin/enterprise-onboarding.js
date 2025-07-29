/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const Boom = require('@hapi/boom');
const isSANB = require('is-string-and-not-blank');

const { EnterpriseAccounts, Users } = require('#models');
const config = require('#config');
const email = require('#helpers/email');

// Create new enterprise account from inquiry
async function createFromUser(ctx) {
  const user = await Users.findById(ctx.params.userId);

  if (!user) {
    return ctx.throw(Boom.notFound(ctx.translateError('INVALID_USER')));
  }

  // Check if enterprise account already exists
  const existingAccount = await EnterpriseAccounts.findOne({ user: user._id });
  if (existingAccount) {
    return ctx.throw(
      Boom.badRequest(ctx.translateError('ENTERPRISE_ACCOUNT_ALREADY_EXISTS'))
    );
  }

  const enterpriseData = {
    user: user._id,
    company_name:
      ctx.request.body.company_name ||
      user[config.passport.fields.organizationName] ||
      'Unknown Company',
    company_size: ctx.request.body.company_size || '1-10',
    industry: ctx.request.body.industry,
    website: ctx.request.body.website,
    primary_contact: {
      name:
        `${user[config.passport.fields.givenName] || ''} ${
          user[config.passport.fields.familyName] || ''
        }`.trim() || 'Unknown',
      email: user.email,
      phone: ctx.request.body.phone,
      title: ctx.request.body.title
    },
    requirements: {
      estimated_users: ctx.request.body.estimated_users
        ? Number.parseInt(ctx.request.body.estimated_users, 10)
        : 1,
      email_volume_monthly: ctx.request.body.email_volume_monthly
        ? Number.parseInt(ctx.request.body.email_volume_monthly, 10)
        : 0,
      compliance_needs: ctx.request.body.compliance_needs
        ? ctx.request.body.compliance_needs.split(',').map((s) => s.trim())
        : [],
      security_requirements: ctx.request.body.security_requirements
        ? ctx.request.body.security_requirements.split(',').map((s) => s.trim())
        : [],
      integration_needs: ctx.request.body.integration_needs
        ? ctx.request.body.integration_needs.split(',').map((s) => s.trim())
        : [],
      migration_timeline: ctx.request.body.migration_timeline,
      current_provider: ctx.request.body.current_provider,
      special_requirements: ctx.request.body.special_requirements
    },
    onboarding_status: 'inquiry_received',
    timeline: [
      {
        status: 'inquiry_received',
        notes: 'Enterprise account created from user inquiry',
        updated_by: ctx.state.user.email,
        date: new Date()
      }
    ],
    account_manager: {
      name:
        ctx.state.user[config.passport.fields.givenName] +
        ' ' +
        ctx.state.user[config.passport.fields.familyName],
      email: ctx.state.user.email
    }
  };

  const enterpriseAccount = new EnterpriseAccounts(enterpriseData);
  await enterpriseAccount.save();

  // Send welcome email to the enterprise contact
  try {
    await email({
      template: 'enterprise-welcome',
      message: {
        to: user.email
      },
      locals: {
        user,
        enterpriseAccount
      }
    });
  } catch (err) {
    ctx.logger.error(err);
  }

  if (ctx.accepts('html')) {
    ctx.flash('success', ctx.translate('ENTERPRISE_ACCOUNT_CREATED'));
    return ctx.redirect(`/admin/enterprise/accounts/${enterpriseAccount._id}`);
  }

  ctx.body = {
    message: ctx.translate('ENTERPRISE_ACCOUNT_CREATED'),
    enterpriseAccount
  };
}

// Update onboarding status
async function updateStatus(ctx) {
  const enterpriseAccount = await EnterpriseAccounts.findById(ctx.params.id);

  if (!enterpriseAccount) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  const newStatus = ctx.request.body.status;
  const notes = ctx.request.body.notes || `Status updated to ${newStatus}`;

  await enterpriseAccount.addTimelineEntry(
    newStatus,
    notes,
    ctx.state.user.email
  );

  // Trigger automated actions based on status
  switch (newStatus) {
    case 'proposal_sent': {
      await sendProposalEmail(enterpriseAccount);
      break;
    }

    case 'contract_signed': {
      await initiateAccountSetup(enterpriseAccount);
      break;
    }

    case 'payment_received': {
      await activateEnterpriseFeatures(enterpriseAccount);
      break;
    }

    case 'completed': {
      await sendWelcomePackage(enterpriseAccount);
      break;
    }
  }

  if (ctx.accepts('html')) {
    ctx.flash('success', ctx.translate('ONBOARDING_STATUS_UPDATED'));
    return ctx.redirect('back');
  }

  ctx.body = { message: ctx.translate('ONBOARDING_STATUS_UPDATED') };
}

// Get accounts that need attention
async function needsAttention(ctx) {
  const accounts = await EnterpriseAccounts.getAccountsNeedingAttention();

  if (ctx.accepts('html')) {
    ctx.state.accounts = accounts;
    return ctx.render('admin/enterprise/needs-attention');
  }

  ctx.body = { accounts };
}

// Helper function to send proposal email
async function sendProposalEmail(enterpriseAccount) {
  try {
    await email({
      template: 'enterprise-proposal',
      message: {
        to: enterpriseAccount.primary_contact.email
      },
      locals: {
        enterpriseAccount
      }
    });
  } catch (err) {
    console.error('Failed to send proposal email:', err);
  }
}

// Helper function to initiate account setup
async function initiateAccountSetup(enterpriseAccount) {
  // Update user to enterprise plan
  await Users.findByIdAndUpdate(enterpriseAccount.user, {
    plan: 'enterprise',
    plan_set_at: new Date()
  });

  // Send setup instructions
  try {
    await email({
      template: 'enterprise-setup',
      message: {
        to: enterpriseAccount.primary_contact.email
      },
      locals: {
        enterpriseAccount
      }
    });
  } catch (err) {
    console.error('Failed to send setup email:', err);
  }
}

// Helper function to activate enterprise features
async function activateEnterpriseFeatures(enterpriseAccount) {
  // Enable enterprise features for the user
  const user = await Users.findById(enterpriseAccount.user);
  if (user) {
    user.has_enterprise_access = true;
    await user.save();
  }

  // Send activation confirmation
  try {
    await email({
      template: 'enterprise-activated',
      message: {
        to: enterpriseAccount.primary_contact.email
      },
      locals: {
        enterpriseAccount
      }
    });
  } catch (err) {
    console.error('Failed to send activation email:', err);
  }
}

// Helper function to send welcome package
async function sendWelcomePackage(enterpriseAccount) {
  try {
    await email({
      template: 'enterprise-welcome-package',
      message: {
        to: enterpriseAccount.primary_contact.email
      },
      locals: {
        enterpriseAccount
      }
    });
  } catch (err) {
    console.error('Failed to send welcome package:', err);
  }
}

module.exports = {
  createFromUser,
  updateStatus,
  needsAttention
};
