/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const Boom = require('@hapi/boom');
const RE2 = require('re2');
const isSANB = require('is-string-and-not-blank');
const paginate = require('koa-ctx-paginate');
const parser = require('mongodb-query-parser');
const dayjs = require('dayjs-with-plugins');
const _ = require('#helpers/lodash');

const { Users, Domains, Payments } = require('#models');
const config = require('#config');

const ENTERPRISE_SEARCH_PATHS = [
  'email',
  config.passport.fields.givenName,
  config.passport.fields.familyName,
  config.passport.fields.organizationName
];

async function list(ctx) {
  let query = {};

  // Filter for enterprise accounts (team plan or enhanced_protection with multiple domains)
  const enterpriseQuery = {
    $or: [
      { plan: 'team' },
      {
        plan: 'enhanced_protection',
        // Users with multiple domains could be considered enterprise
        // This would need adjustment based on your enterprise criteria
      }
    ],
    [config.userFields.isBanned]: false,
    [config.userFields.hasVerifiedEmail]: true
  };

  if (ctx.query.q) {
    const searchQuery = { $or: [] };

    for (const field of ENTERPRISE_SEARCH_PATHS) {
      searchQuery.$or.push(
        { [field]: { $regex: ctx.query.q, $options: 'i' } },
        { [field]: { $regex: _.escapeRegExp(ctx.query.q), $options: 'i' } }
      );
    }

    query = {
      $and: [enterpriseQuery, searchQuery]
    };
  } else {
    query = enterpriseQuery;
  }

  if (isSANB(ctx.query.mongodb_query)) {
    try {
      const customQuery = parser.parseFilter(ctx.query.mongodb_query);
      if (!customQuery || Object.keys(customQuery).length === 0)
        throw new Error('Query was not parsed properly');
      query = {
        $and: [enterpriseQuery, customQuery]
      };
    } catch (err) {
      ctx.logger.warn(err);
      ctx.flash('warning', err.message);
    }
  }

  // Sort by created date (newest first) and then by plan
  const sort = { created_at: -1, plan: 1 };

  try {
    const [users, itemCount] = await Promise.all([
      Users.find(query)
        .populate('domains')
        .sort(sort)
        .limit(ctx.query.limit)
        .skip(ctx.paginate.skip)
        .lean()
        .exec(),
      Users.countDocuments(query)
    ]);

    // Get recent payments for each enterprise user
    const userIds = users.map(user => user._id);
    const recentPayments = await Payments.find({
      user: { $in: userIds }
    })
      .sort({ created_at: -1 })
      .limit(userIds.length * 3) // Get up to 3 recent payments per user
      .lean()
      .exec();

    // Group payments by user
    const paymentsByUser = _.groupBy(recentPayments, 'user');

    // Enhance users with payment and domain information
    const enhancedUsers = users.map(user => ({
      ...user,
      recentPayments: paymentsByUser[user._id.toString()] || [],
      domainCount: user.domains ? user.domains.length : 0,
      totalRevenue: paymentsByUser[user._id.toString()]
        ? paymentsByUser[user._id.toString()].reduce((sum, payment) => sum + (payment.amount || 0), 0)
        : 0
    }));

    const pageCount = Math.ceil(itemCount / ctx.query.limit);

    if (ctx.accepts('html')) {
      return ctx.render('admin/enterprise', {
        users: enhancedUsers,
        pageCount,
        itemCount,
        pages: paginate.getArrayPages(ctx)(6, pageCount, ctx.query.page)
      });
    }

    const table = `<div class="table-responsive">
      <table class="table table-striped table-hover">
        <thead class="thead-dark">
          <tr>
            <th class="align-middle">
              <a class="text-white" href="?${qs.stringify({
                ...ctx.query,
                sort: 'email'
              })}">
                ${ctx.translate('Email')}
              </a>
            </th>
            <th class="align-middle">
              <a class="text-white" href="?${qs.stringify({
                ...ctx.query,
                sort: 'plan'
              })}">
                ${ctx.translate('Plan')}
              </a>
            </th>
            <th class="align-middle">${ctx.translate('Domains')}</th>
            <th class="align-middle">${ctx.translate('Total Revenue')}</th>
            <th class="align-middle">${ctx.translate('Created')}</th>
            <th class="align-middle">${ctx.translate('Actions')}</th>
          </tr>
        </thead>
        <tbody>
          ${enhancedUsers.map(user => `
            <tr>
              <td class="align-middle">
                <a href="/admin/users/${user._id}" class="font-weight-bold">
                  ${user.email}
                </a>
                ${user[config.passport.fields.organizationName] 
                  ? `<br><small class="text-muted">${user[config.passport.fields.organizationName]}</small>` 
                  : ''}
              </td>
              <td class="align-middle">
                <span class="badge badge-${user.plan === 'team' ? 'primary' : 'success'}">
                  ${ctx.translate(user.plan)}
                </span>
              </td>
              <td class="align-middle">
                <span class="badge badge-secondary">${user.domainCount}</span>
              </td>
              <td class="align-middle">
                $${(user.totalRevenue / 100).toFixed(2)}
              </td>
              <td class="align-middle">
                <time datetime="${dayjs(user.created_at).toISOString()}">
                  ${dayjs(user.created_at).format('M/D/YY')}
                </time>
              </td>
              <td class="align-middle">
                <a href="/admin/users/${user._id}" class="btn btn-sm btn-outline-primary">
                  ${ctx.translate('View')}
                </a>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;

    ctx.body = table;
  } catch (err) {
    ctx.logger.error(err);
    ctx.throw(Boom.badRequest(err.message));
  }
}

async function dashboard(ctx) {
  try {
    // Get enterprise metrics
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const enterpriseQuery = {
      $or: [{ plan: 'team' }, { plan: 'enhanced_protection' }],
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
            'user.plan': { $in: ['team', 'enhanced_protection'] },
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
            plan: { $in: ['team', 'enhanced_protection'] },
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
    const filteredPayments = enterprisePayments.filter(payment => payment.user);

    // Calculate growth rate
    const previousMonthStart = new Date(thirtyDaysAgo.getTime() - 30 * 24 * 60 * 60 * 1000);
    const previousMonthEnterprise = await Users.countDocuments({
      ...enterpriseQuery,
      created_at: { $gte: previousMonthStart, $lt: thirtyDaysAgo }
    });

    const growthRate = previousMonthEnterprise > 0 
      ? ((newEnterpriseThisMonth - previousMonthEnterprise) / previousMonthEnterprise * 100).toFixed(1)
      : 0;

    const revenueData = enterpriseRevenue[0] || { total: 0, count: 0 };

    if (ctx.accepts('html')) {
      return ctx.render('admin/enterprise/dashboard', {
        totalEnterprise,
        newEnterpriseThisMonth,
        growthRate,
        totalRevenue: revenueData.total,
        revenueCount: revenueData.count,
        averageRevenue: revenueData.count > 0 ? (revenueData.total / revenueData.count) : 0,
        recentPayments: filteredPayments
      });
    }

    ctx.body = {
      totalEnterprise,
      newEnterpriseThisMonth,
      growthRate,
      totalRevenue: revenueData.total,
      revenueCount: revenueData.count,
      averageRevenue: revenueData.count > 0 ? (revenueData.total / revenueData.count) : 0
    };
  } catch (err) {
    ctx.logger.error(err);
    ctx.throw(Boom.badRequest(err.message));
  }
}

module.exports = {
  list,
  dashboard
};