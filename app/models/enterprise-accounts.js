/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const mongoose = require('mongoose');
const mongooseCommonPlugin = require('mongoose-common-plugin');

// <https://github.com/Automattic/mongoose/issues/5534>
mongoose.Error.messages = require('@ladjs/mongoose-error-messages');

const config = require('#config');

const EnterpriseAccount = new mongoose.Schema({
  // Association with user account
  user: {
    type: mongoose.Schema.ObjectId,
    ref: 'Users',
    required: true,
    index: true
  },

  // Company Information
  company_name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  website: {
    type: String,
    trim: true,
    maxlength: 200
  },
  address: {
    street: { type: String, trim: true, maxlength: 200 },
    city: { type: String, trim: true, maxlength: 100 },
    state: { type: String, trim: true, maxlength: 100 },
    postal_code: { type: String, trim: true, maxlength: 20 },
    country: { type: String, trim: true, maxlength: 100 }
  },

  // Primary Contact Information
  primary_contact: {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, trim: true, lowercase: true }
  },

  // Technical Contact (if different)
  technical_contact: {
    name: { type: String, trim: true, maxlength: 100 },
    email: { type: String, trim: true, lowercase: true }
  },

  // Billing Contact (if different)
  billing_contact: {
    name: { type: String, trim: true, maxlength: 100 },
    email: { type: String, trim: true, lowercase: true }
  },

  // Requirements & Configuration
  requirements: {
    email_volume_monthly: { type: Number, min: 0 },
    compliance_needs: [{ type: String, trim: true }], // HIPAA, SOX, etc.
    security_requirements: [{ type: String, trim: true }], // SSO, 2FA, etc.
    integration_needs: [{ type: String, trim: true }], // CRM, Help desk, etc.
    migration_timeline: { type: String, trim: true },
    special_requirements: { type: String, trim: true, maxlength: 1000 }
  },

  // Onboarding Status
  onboarding_status: {
    type: String,
    enum: [
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
    ],
    default: 'inquiry_received',
    index: true
  },

  // Timeline Tracking
  timeline: [
    {
      status: { type: String, required: true },
      date: { type: Date, default: Date.now },
      notes: { type: String, trim: true },
      updated_by: { type: String, trim: true } // Admin who made the update
    }
  ],

  // Contract & Legal
  contract: {
    signed_date: Date,
    effective_date: Date,
    renewal_date: Date,
    contract_value: { type: Number, min: 0 }, // in cents
    payment_terms: { type: String, trim: true }, // Net 30, quarterly, etc.
    auto_renewal: { type: Boolean, default: true }
  },


  // Payment Information
  payment_info: {
    billing_cycle: {
      type: String,
      enum: ['monthly', 'quarterly', 'annual'],
      default: 'annual'
    },
    next_billing_date: Date,
    last_payment_date: Date,
    last_payment_amount: { type: Number, min: 0 }, // in cents
    payment_method: {
      type: String,
      enum: ['credit_card', 'ach', 'wire_transfer', 'purchase_order'],
      default: 'credit_card'
    },
    purchase_order_required: { type: Boolean, default: false }
  },

  // Account Manager
  account_manager: {
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true }
  },

  // Success Metrics
  success_metrics: {
    onboarding_completion_date: Date,
    user_adoption_rate: { type: Number, min: 0, max: 100 },
    satisfaction_score: { type: Number, min: 1, max: 10 },
    support_ticket_count: { type: Number, default: 0 },
    last_activity_date: Date
  },

  // Notes and Communication
  notes: [
    {
      content: { type: String, required: true, trim: true },
      created_by: { type: String, required: true, trim: true },
      created_at: { type: Date, default: Date.now },
      type: {
        type: String,
        enum: ['general', 'technical', 'billing', 'support'],
        default: 'general'
      }
    }
  ],

  // Flags
  is_priority_account: { type: Boolean, default: false },
  is_active: { type: Boolean, default: true },

  // Custom fields for future extensibility
  custom_fields: mongoose.Schema.Types.Mixed
});

EnterpriseAccount.plugin(mongooseCommonPlugin, {
  object: 'enterprise_account',
  locale: false
});

// Indexes for performance
EnterpriseAccount.index({ user: 1, is_active: 1 });
EnterpriseAccount.index({ company_name: 1 });
EnterpriseAccount.index({ onboarding_status: 1 });
EnterpriseAccount.index({ 'contract.renewal_date': 1 });
EnterpriseAccount.index({ 'payment_info.next_billing_date': 1 });

// Virtual for getting the latest timeline entry
EnterpriseAccount.virtual('latest_status').get(function () {
  return this.timeline.length > 0
    ? this.timeline[this.timeline.length - 1]
    : null;
});

// Method to add timeline entry
EnterpriseAccount.methods.addTimelineEntry = function (
  status,
  notes,
  updatedBy
) {
  this.timeline.push({
    status,
    notes,
    updated_by: updatedBy,
    date: new Date()
  });
  this.onboarding_status = status;
  return this.save();
};

// Method to calculate next billing date
EnterpriseAccount.methods.calculateNextBillingDate = function () {
  if (!this.payment_info.last_payment_date) return null;

  const lastPayment = new Date(this.payment_info.last_payment_date);
  switch (this.payment_info.billing_cycle) {
    case 'monthly': {
      return new Date(lastPayment.setMonth(lastPayment.getMonth() + 1));
    }

    case 'quarterly': {
      return new Date(lastPayment.setMonth(lastPayment.getMonth() + 3));
    }

    case 'annual': {
      return new Date(lastPayment.setFullYear(lastPayment.getFullYear() + 1));
    }

    default: {
      return null;
    }
  }
};

// Static method to get accounts needing renewal attention
EnterpriseAccount.statics.getAccountsNeedingAttention = function () {
  const thirtyDaysFromNow = new Date();
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  return this.find({
    is_active: true,
    $or: [
      { 'contract.renewal_date': { $lte: thirtyDaysFromNow } },
      { 'payment_info.next_billing_date': { $lte: thirtyDaysFromNow } },
      {
        onboarding_status: {
          $in: ['proposal_sent', 'contract_negotiation', 'payment_pending']
        }
      }
    ]
  }).populate('user', 'email plan');
};

module.exports = mongoose.model('EnterpriseAccount', EnterpriseAccount);
