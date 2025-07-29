/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const Boom = require('@hapi/boom');
const isSANB = require('is-string-and-not-blank');

const { EnterpriseAccounts, Users } = require('#models');
const email = require('#helpers/email');

// Workflow dashboard showing accounts by status
async function dashboard(ctx) {
  // Get all enterprise accounts grouped by status
  const accountsByStatus = await EnterpriseAccounts.aggregate([
    { $match: { is_active: true } },
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'user'
      }
    },
    { $unwind: '$user' },
    {
      $group: {
        _id: '$onboarding_status',
        accounts: {
          $push: {
            _id: '$_id',
            company_name: '$company_name',
            primary_contact: '$primary_contact',
            user: '$user',
            created_at: '$created_at',
            updated_at: '$updated_at',
            is_priority_account: '$is_priority_account',
            timeline: { $slice: ['$timeline', -1] } // Get latest timeline entry
          }
        },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  // Define workflow stages in order
  const workflowStages = [
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

  // Organize data by workflow stages
  const workflowData = workflowStages.map((stage) => {
    const stageData = accountsByStatus.find((item) => item._id === stage);
    return {
      status: stage,
      count: stageData ? stageData.count : 0,
      accounts: stageData ? stageData.accounts : []
    };
  });

  // Get accounts needing attention (overdue or stuck)
  const needsAttention = await EnterpriseAccounts.getAccountsNeedingAttention();

  // Calculate workflow metrics
  const totalAccounts = accountsByStatus.reduce(
    (sum, stage) => sum + stage.count,
    0
  );
  const completedAccounts =
    accountsByStatus.find((s) => s._id === 'completed')?.count || 0;
  const activeAccounts = totalAccounts - completedAccounts;
  const conversionRate =
    totalAccounts > 0
      ? Math.round((completedAccounts / totalAccounts) * 100)
      : 0;

  // Get recent status changes (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const recentChanges = await EnterpriseAccounts.find({
    'timeline.date': { $gte: sevenDaysAgo }
  })
    .populate('user', 'email')
    .sort({ 'timeline.date': -1 })
    .limit(10)
    .lean()
    .exec();

  ctx.state.workflowData = workflowData;
  ctx.state.needsAttention = needsAttention;
  ctx.state.totalAccounts = totalAccounts;
  ctx.state.activeAccounts = activeAccounts;
  ctx.state.completedAccounts = completedAccounts;
  ctx.state.conversionRate = conversionRate;
  ctx.state.recentChanges = recentChanges;

  if (ctx.accepts('html')) {
    return ctx.render('admin/enterprise/workflow');
  }

  ctx.body = {
    workflowData,
    needsAttention,
    metrics: {
      totalAccounts,
      activeAccounts,
      completedAccounts,
      conversionRate
    },
    recentChanges
  };
}

// Bulk status update
async function bulkUpdateStatus(ctx) {
  const { accountIds, newStatus, notes } = ctx.request.body;

  if (!Array.isArray(accountIds) || accountIds.length === 0) {
    return ctx.throw(
      Boom.badRequest(ctx.translateError('ACCOUNT_IDS_REQUIRED'))
    );
  }

  if (!isSANB(newStatus)) {
    return ctx.throw(Boom.badRequest(ctx.translateError('STATUS_REQUIRED')));
  }

  const updatedAccounts = [];
  const errors = [];

  for (const accountId of accountIds) {
    try {
      const account = await EnterpriseAccounts.findById(accountId);
      if (account) {
        await account.addTimelineEntry(
          newStatus,
          notes || `Bulk status update to ${newStatus}`,
          ctx.state.user.email
        );
        updatedAccounts.push(account);
      }
    } catch (err) {
      errors.push({ accountId, error: err.message });
    }
  }

  // Send notification emails for certain status changes
  if (
    ['proposal_sent', 'contract_signed', 'payment_received'].includes(newStatus)
  ) {
    for (const account of updatedAccounts) {
      try {
        await sendStatusNotificationEmail(account, newStatus);
      } catch (err) {
        ctx.logger.error('Failed to send status notification email:', err);
      }
    }
  }

  if (ctx.accepts('html')) {
    ctx.flash(
      'success',
      ctx.translate('BULK_STATUS_UPDATE_SUCCESS', updatedAccounts.length)
    );
    if (errors.length > 0) {
      ctx.flash(
        'warning',
        ctx.translate('BULK_UPDATE_PARTIAL_ERRORS', errors.length)
      );
    }

    return ctx.redirect('back');
  }

  ctx.body = {
    message: ctx.translate(
      'BULK_STATUS_UPDATE_SUCCESS',
      updatedAccounts.length
    ),
    updated: updatedAccounts.length,
    errors: errors.length
  };
}

// Move account to next workflow stage
async function moveToNextStage(ctx) {
  const account = await EnterpriseAccounts.findById(ctx.params.id);

  if (!account) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  const workflowStages = [
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

  const currentIndex = workflowStages.indexOf(account.onboarding_status);
  if (currentIndex === -1 || currentIndex === workflowStages.length - 1) {
    return ctx.throw(
      Boom.badRequest(ctx.translateError('CANNOT_ADVANCE_STAGE'))
    );
  }

  const nextStatus = workflowStages[currentIndex + 1];
  const notes = ctx.request.body.notes || `Advanced to ${nextStatus}`;

  await account.addTimelineEntry(nextStatus, notes, ctx.state.user.email);

  // Trigger automated actions
  await triggerAutomatedActions(account, nextStatus);

  if (ctx.accepts('html')) {
    ctx.flash('success', ctx.translate('ACCOUNT_ADVANCED_TO_NEXT_STAGE'));
    return ctx.redirect('back');
  }

  ctx.body = {
    message: ctx.translate('ACCOUNT_ADVANCED_TO_NEXT_STAGE'),
    newStatus: nextStatus
  };
}

// Set reminder for account
async function setReminder(ctx) {
  const account = await EnterpriseAccounts.findById(ctx.params.id);

  if (!account) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  const { reminderDate, reminderType, notes } = ctx.request.body;

  if (!reminderDate) {
    return ctx.throw(
      Boom.badRequest(ctx.translateError('REMINDER_DATE_REQUIRED'))
    );
  }

  // Add reminder as a special timeline entry
  account.timeline.push({
    status: `reminder_${reminderType || 'general'}`,
    notes: notes || 'Follow-up reminder set',
    updated_by: ctx.state.user.email,
    date: new Date(reminderDate)
  });

  await account.save();

  if (ctx.accepts('html')) {
    ctx.flash('success', ctx.translate('REMINDER_SET'));
    return ctx.redirect('back');
  }

  ctx.body = { message: ctx.translate('REMINDER_SET') };
}

// Get workflow analytics
async function analytics(ctx) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  // Conversion funnel analysis
  const funnelData = await EnterpriseAccounts.aggregate([
    { $match: { created_at: { $gte: thirtyDaysAgo } } },
    {
      $group: {
        _id: '$onboarding_status',
        count: { $sum: 1 },
        avgDaysInStage: {
          $avg: {
            $divide: [
              { $subtract: ['$updated_at', '$created_at'] },
              1000 * 60 * 60 * 24
            ]
          }
        }
      }
    }
  ]);

  // Time to completion analysis
  const completionTimes = await EnterpriseAccounts.aggregate([
    { $match: { onboarding_status: 'completed' } },
    {
      $project: {
        daysToComplete: {
          $divide: [
            { $subtract: ['$updated_at', '$created_at'] },
            1000 * 60 * 60 * 24
          ]
        }
      }
    },
    {
      $group: {
        _id: null,
        avgDaysToComplete: { $avg: '$daysToComplete' },
        minDaysToComplete: { $min: '$daysToComplete' },
        maxDaysToComplete: { $max: '$daysToComplete' }
      }
    }
  ]);

  ctx.state.funnelData = funnelData;
  ctx.state.completionTimes = completionTimes[0] || {};

  if (ctx.accepts('html')) {
    return ctx.render('admin/enterprise/analytics');
  }

  ctx.body = { funnelData, completionTimes: completionTimes[0] || {} };
}

// Helper function to send status notification emails
async function sendStatusNotificationEmail(account, status) {
  const templates = {
    proposal_sent: 'enterprise-proposal-sent',
    contract_signed: 'enterprise-contract-signed',
    payment_received: 'enterprise-payment-received'
  };

  const template = templates[status];
  if (!template) return;

  try {
    await email({
      template,
      message: {
        to: account.primary_contact.email
      },
      locals: {
        account,
        status
      }
    });
  } catch (err) {
    console.error(`Failed to send ${template} email:`, err);
  }
}

// Helper function to trigger automated actions based on status
async function triggerAutomatedActions(account, status) {
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
      // Enable enterprise features
      const user = await Users.findById(account.user);
      if (user) {
        user.has_enterprise_access = true;
        await user.save();
      }

      break;
    }

    case 'completed': {
      // Set success metrics
      account.success_metrics.onboarding_completion_date = new Date();
      await account.save();
      break;
    }

    default: {
      // No automated action for this status
      break;
    }
  }
}

module.exports = {
  dashboard,
  bulkUpdateStatus,
  moveToNextStage,
  setReminder,
  analytics
};
