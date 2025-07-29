/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const Boom = require('@hapi/boom');
const isSANB = require('is-string-and-not-blank');
const paginate = require('koa-ctx-paginate');
const parser = require('mongodb-query-parser');
const _ = require('#helpers/lodash');

const { Users, Domains, Payments, EnterpriseAccounts } = require('#models');
const config = require('#config');

const ENTERPRISE_SEARCH_PATHS = [
  'company_name',
  'primary_contact.name',
  'primary_contact.email'
];


async function list(ctx) {
  let query = {};

  // Base query for active enterprise accounts
  const baseQuery = {
    is_active: true
  };

  if (ctx.query.q) {
    const searchOr = [];

    // Search in enterprise account fields
    for (const field of ENTERPRISE_SEARCH_PATHS) {
      searchOr.push(
        { [field]: { $regex: ctx.query.q, $options: 'i' } },
        { [field]: { $regex: _.escapeRegExp(ctx.query.q), $options: 'i' } }
      );
    }

    // Search in domains (for domain name search)
    const domainResults = await Domains.find({
      name: { $regex: ctx.query.q, $options: 'i' }
    })
      .select('members.user')
      .lean();

    const userIdsFromDomains = [];
    for (const domain of domainResults) {
      for (const member of domain.members) {
        if (member.user) userIdsFromDomains.push(member.user);
      }
    }

    if (userIdsFromDomains.length > 0) {
      searchOr.push({ user: { $in: userIdsFromDomains } });
    }

    if (searchOr.length > 0) {
      query.$or = searchOr;
    }
  }

  let $sort = { created_at: -1 };
  if (ctx.query.sort) {
    const order = ctx.query.sort.startsWith('-') ? -1 : 1;
    $sort = {
      [order === -1 ? ctx.query.sort.slice(1) : ctx.query.sort]: order
    };
  }

  if (isSANB(ctx.query.mongodb_query)) {
    try {
      const mongoQuery = parser.parseFilter(ctx.query.mongodb_query);
      if (!mongoQuery || Object.keys(mongoQuery).length === 0)
        throw new Error('Query was not parsed properly');

      query =
        ctx.query.q && Object.keys(query).length > 0
          ? { $and: [baseQuery, query, mongoQuery] }
          : { $and: [baseQuery, mongoQuery] };
    } catch (err) {
      ctx.logger.warn(err);
      throw Boom.badRequest(err.message);
    }
  } else {
    query =
      ctx.query.q && Object.keys(query).length > 0
        ? { $and: [baseQuery, query] }
        : baseQuery;
  }

  const results = await EnterpriseAccounts.aggregate([
    { $match: query },
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
      $lookup: {
        from: 'domains',
        localField: 'user._id',
        foreignField: 'members.user',
        as: 'domains'
      }
    },
    {
      $lookup: {
        from: 'payments',
        localField: 'user._id',
        foreignField: 'user',
        as: 'payments'
      }
    },
    {
      $addFields: {
        domainCount: { $size: '$domains' },
        userCount: {
          $reduce: {
            input: '$domains',
            initialValue: 0,
            in: {
              $add: ['$$value', { $size: { $ifNull: ['$$this.members', []] } }]
            }
          }
        },
        aliasCount: {
          $reduce: {
            input: '$domains',
            initialValue: 0,
            in: {
              $add: ['$$value', { $size: { $ifNull: ['$$this.aliases', []] } }]
            }
          }
        },
        lastPayment: {
          $arrayElemAt: [
            { $sortArray: { input: '$payments', sortBy: { created_at: -1 } } },
            0
          ]
        },
        totalRevenue: { $sum: '$payments.amount' }
      }
    },
    {
      $facet: {
        data: [
          { $sort },
          { $skip: ctx.paginate.skip },
          { $limit: ctx.paginate.limit || 50 }
        ],
        count: [{ $count: 'count' }]
      }
    }
  ]);

  const enterprises = results[0].data;
  const itemCount = results[0].count;

  const pageCount = Math.ceil(
    (itemCount[0]?.count || 0) / (ctx.paginate.limit || 50)
  );

  if (
    ctx.accepts('html') &&
    !ctx.request.header.accept.includes('application/json')
  ) {
    return ctx.render('admin/enterprise/index', {
      enterprises,
      pageCount,
      itemCount: itemCount[0]?.count || 0,
      pages: paginate.getArrayPages(ctx)(6, pageCount, ctx.query.page)
    });
  }

  const table = await ctx.render('admin/enterprise/_table', {
    enterprises,
    pageCount,
    itemCount: itemCount[0]?.count || 0,
    pages: paginate.getArrayPages(ctx)(6, pageCount, ctx.query.page)
  });

  ctx.body = { table };
}

async function dashboard(ctx) {
  try {
    // Get enterprise metrics
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const enterpriseQuery = {
      $or: [
        { plan: 'enterprise' },
        { plan: 'team' },
        { plan: 'enhanced_protection' }
      ],
      [config.userFields.isBanned]: false,
      [config.userFields.hasVerifiedEmail]: true
    };

    const [
      totalEnterprise,
      newEnterpriseThisMonth,
      enterpriseRevenue,
      enterprisePayments
    ] = await Promise.all([
      Users.countDocuments(enterpriseQuery),
      Users.countDocuments({
        ...enterpriseQuery,
        created_at: { $gte: thirtyDaysAgo }
      }),
      Payments.aggregate([
        {
          $lookup: {
            from: 'users',
            localField: 'user',
            foreignField: '_id',
            as: 'user'
          }
        },
        {
          $unwind: '$user'
        },
        {
          $match: {
            'user.plan': { $in: ['enterprise', 'team', 'enhanced_protection'] },
            'user.is_banned': false,
            'user.has_verified_email': true
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ]),
      Payments.find({})
        .populate({
          path: 'user',
          match: {
            plan: { $in: ['enterprise', 'team', 'enhanced_protection'] },
            is_banned: false,
            has_verified_email: true
          }
        })
        .sort({ created_at: -1 })
        .limit(10)
        .lean()
        .exec()
    ]);

    // Filter out payments where user was null after populate
    const filteredPayments = enterprisePayments.filter(
      (payment) => payment.user
    );

    // Calculate growth rate
    const previousMonthStart = new Date(
      thirtyDaysAgo.getTime() - 30 * 24 * 60 * 60 * 1000
    );
    const previousMonthEnterprise = await Users.countDocuments({
      ...enterpriseQuery,
      created_at: { $gte: previousMonthStart, $lt: thirtyDaysAgo }
    });

    const growthRate =
      previousMonthEnterprise > 0
        ? (
            ((newEnterpriseThisMonth - previousMonthEnterprise) /
              previousMonthEnterprise) *
            100
          ).toFixed(1)
        : 0;

    const revenueData = enterpriseRevenue[0] || { total: 0, count: 0 };

    if (ctx.accepts('html')) {
      return ctx.render('admin/enterprise/dashboard', {
        totalEnterprise,
        newEnterpriseThisMonth,
        growthRate,
        totalRevenue: revenueData.total,
        revenueCount: revenueData.count,
        averageRevenue:
          revenueData.count > 0 ? revenueData.total / revenueData.count : 0,
        recentPayments: filteredPayments
      });
    }

    ctx.body = {
      totalEnterprise,
      newEnterpriseThisMonth,
      growthRate,
      totalRevenue: revenueData.total,
      revenueCount: revenueData.count,
      averageRevenue:
        revenueData.count > 0 ? revenueData.total / revenueData.count : 0
    };
  } catch (err) {
    ctx.logger.error(err);
    ctx.throw(Boom.badRequest(err.message));
  }
}

async function create(ctx) {
  try {
    const {
      company_name,
      website,
      primary_contact_name,
      primary_contact_email,
      primary_contact_phone,
      primary_contact_title,
      estimated_users,
      current_provider,
      initial_notes
    } = ctx.request.body;

    // Validate required fields
    if (!company_name || !primary_contact_name || !primary_contact_email) {
      throw Boom.badRequest('Company name, contact name, and email are required');
    }

    // Check if user exists with this email
    let user = await Users.findOne({ email: primary_contact_email.toLowerCase() });
    
    // If user doesn't exist, create a basic user record
    if (!user) {
      user = await Users.create({
        email: primary_contact_email.toLowerCase(),
        display_name: primary_contact_name,
        given_name: primary_contact_name.split(' ')[0],
        family_name: primary_contact_name.split(' ').slice(1).join(' ') || '',
        company_name,
        plan: 'free', // Start as free, will be upgraded during onboarding
        has_verified_email: false, // They'll need to verify
        has_set_password: false,
        is_banned: false,
        is_removed: false
      });
    }

    // Create the enterprise account
    const enterpriseAccountData = {
      user: user._id,
      company_name,
      website: website || null,
      
      primary_contact: {
        name: primary_contact_name,
        email: primary_contact_email.toLowerCase(),
        phone: primary_contact_phone || null,
        title: primary_contact_title || null
      },

      requirements: {
        estimated_users: estimated_users ? parseInt(estimated_users, 10) : null,
        current_provider: current_provider || null
      },

      onboarding_status: 'inquiry_received',
      
      timeline: [{
        status: 'inquiry_received',
        date: new Date(),
        notes: initial_notes || 'Enterprise account created manually via admin panel',
        updated_by: ctx.state.user.email
      }],

      is_active: true
    };

    // Add initial note if provided
    if (initial_notes) {
      enterpriseAccountData.notes = [{
        content: initial_notes,
        created_by: ctx.state.user.email,
        created_at: new Date(),
        type: 'general'
      }];
    }

    const enterpriseAccount = await EnterpriseAccounts.create(enterpriseAccountData);

    const message = ctx.translate('ENTERPRISE_ACCOUNT_CREATED');
    if (ctx.accepts('html')) {
      ctx.flash('custom', {
        title: ctx.request.t('Success'),
        text: message,
        type: 'success',
        toast: true,
        showConfirmButton: false,
        timer: 3000,
        position: 'top'
      });
      ctx.redirect(`/admin/enterprise/accounts/${enterpriseAccount._id}`);
    } else {
      ctx.body = { message, enterpriseAccount };
    }
  } catch (err) {
    ctx.logger.error(err);
    throw Boom.badRequest(err.message);
  }
}

module.exports = {
  list,
  dashboard,
  create
};
