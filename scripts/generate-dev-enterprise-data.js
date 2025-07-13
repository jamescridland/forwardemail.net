/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

// eslint-disable-next-line import/no-unassigned-import
require('#config/env');

const process = require('node:process');

// eslint-disable-next-line import/no-unassigned-import
require('#config/env');
// eslint-disable-next-line import/no-unassigned-import
require('#config/mongoose');

const Graceful = require('@ladjs/graceful');
const falso = require('@ngneat/falso');
const mongoose = require('mongoose');
const dayjs = require('dayjs-with-plugins');
const ms = require('ms');

const { Users, Domains, Payments } = require('#models');
const setupMongoose = require('#helpers/setup-mongoose');

const ENTERPRISE_COUNT = 25; // Number of enterprise accounts to create

// Enterprise-focused company data
const ENTERPRISE_COMPANIES = [
  'TechCorp Solutions', 'Global Dynamics Inc', 'Innovation Labs LLC', 'Enterprise Systems Co',
  'Digital Transformation Partners', 'CloudFirst Technologies', 'SecureComm Enterprise',
  'DataFlow Solutions', 'NextGen Communications', 'Enterprise Connect Inc',
  'Business Communications Ltd', 'Professional Email Services', 'Corporate Solutions Group',
  'Advanced Technology Partners', 'Integrated Business Systems', 'Digital Enterprise LLC',
  'Modern Communications Co', 'Enterprise Tech Solutions', 'Professional Services Group',
  'Business Automation Inc', 'Strategic Technology Partners', 'Corporate Digital Solutions',
  'Enterprise Innovation Lab', 'Advanced Communications Inc', 'Business Technology Group'
];

const ENTERPRISE_DOMAINS = [
  'techcorp.com', 'globaldynamics.io', 'innovationlabs.co', 'enterprisesys.net',
  'digitaltransform.com', 'cloudfirst.tech', 'securecomm.biz', 'dataflow.solutions',
  'nextgencomm.com', 'enterpriseconnect.io', 'bizcomm.ltd', 'proemailserv.com',
  'corpsolutions.group', 'advancedtech.partners', 'integratedbiz.systems',
  'digitalent.llc', 'moderncomm.co', 'enterprisetech.solutions', 'proservices.group',
  'bizautomation.inc', 'strategytech.partners', 'corpdigital.solutions',
  'entinnovation.lab', 'advcomm.inc', 'biztech.group'
];

const COUNTRIES = [
  'United States of America', 
  'Canada', 
  'United Kingdom of Great Britain and Northern Ireland', 
  'Germany', 
  'France', 
  'Australia', 
  'Netherlands', 
  'Sweden', 
  'Switzerland', 
  'Singapore'
];

const graceful = new Graceful({
  mongooses: [mongoose]
});

graceful.listen();

const getRandomCompanyInfo = (index) => {
  const company = ENTERPRISE_COMPANIES[index % ENTERPRISE_COMPANIES.length];
  const domain = ENTERPRISE_DOMAINS[index % ENTERPRISE_DOMAINS.length];
  
  // Generate realistic email based on company domain
  const firstNames = ['john', 'jane', 'mike', 'sarah', 'david', 'lisa', 'robert', 'emily', 'chris', 'amanda'];
  const lastNames = ['smith', 'johnson', 'williams', 'brown', 'jones', 'garcia', 'miller', 'davis', 'rodriguez', 'martinez'];
  
  const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
  const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
  const email = `${firstName}.${lastName}@${domain}`;
  
  return {
    company,
    domain,
    email,
    firstName: firstName.charAt(0).toUpperCase() + firstName.slice(1),
    lastName: lastName.charAt(0).toUpperCase() + lastName.slice(1)
  };
};

const createEnterpriseUser = async (index) => {
  const { company, domain, email, firstName, lastName } = getRandomCompanyInfo(index);
  
  // Check if user already exists
  const existingUser = await Users.findOne({ email });
  if (existingUser) {
    console.log(`User ${email} already exists, skipping...`);
    return existingUser;
  }

  // Randomly assign plan (more team plans for enterprise)
  const plan = Math.random() < 0.7 ? 'team' : 'enhanced_protection';
  
  // Create realistic enterprise user data
  const country = COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)];
  const createdAt = falso.randPastDate({ years: 2 });
  const planSetAt = dayjs(createdAt).add(falso.randNumber({ min: 0, max: 30 }), 'days').toDate();
  
  // Generate plan expiration (1-3 years from plan set date)
  const planExpiresAt = dayjs(planSetAt).add(falso.randNumber({ min: 1, max: 3 }), 'years').toDate();

  const userData = {
    email,
    plan,
    group: Math.random() < 0.1 ? 'admin' : 'user', // 10% chance of being admin
    display_name: `${firstName} ${lastName}`,
    given_name: firstName,
    family_name: lastName,
    company_name: company,
    
    // Enterprise address information
    address_line1: falso.randStreetAddress(),
    address_city: falso.randCity(),
    address_state: falso.randState(),
    address_zip: falso.randZipCode(),
    address_country: country,
    
    // Enterprise features
    has_passed_kyc: Math.random() < 0.8, // 80% have passed KYC
    has_verified_email: true,
    has_set_password: true,
    is_banned: false,
    is_removed: false,
    
    // Plan and timing
    plan_set_at: planSetAt,
    plan_expires_at: planExpiresAt,
    created_at: createdAt,
    updated_at: createdAt,
    
    // Enterprise settings
    timezone: falso.randTimeZone(),
    smtp_limit: plan === 'team' ? falso.randNumber({ min: 1000, max: 10000 }) : falso.randNumber({ min: 300, max: 1000 }),
    max_quota_per_alias: falso.randNumber({ min: 1000000000, max: 10000000000 }), // 1GB to 10GB in bytes
    
    // Subscription management (some have Stripe, some PayPal)
    stripe_customer_id: Math.random() < 0.7 ? `cus_${falso.randAlphaNumeric({ length: 14 }).join('')}` : null,
    paypal_payer_id: Math.random() < 0.3 ? falso.randAlphaNumeric({ length: 13 }).join('').toUpperCase() : null,
    
    // VAT for international businesses (use country abbreviation for VAT)
    company_vat: country !== 'United States of America' && Math.random() < 0.6 ? `${country.substring(0, 2).toUpperCase()}${falso.randNumber({ min: 100000000, max: 999999999 })}` : null,
    
    // Security
    otp_enabled: Math.random() < 0.4, // 40% use 2FA
    
    // Newsletter and communication preferences
    has_newsletter: Math.random() < 0.8 // 80% subscribed to newsletter
  };

  console.log(`Creating enterprise user: ${email} (${company}) - Plan: ${plan}`);
  
  try {
    const user = await Users.create(userData);
    
    // Create some domains for this enterprise user
    await createEnterpriseDomains(user, domain);
    
    // Create payment history for this user
    await createEnterprisePayments(user);
    
    return user;
  } catch (err) {
    console.error(`Error creating user ${email}:`, err.message);
    return null;
  }
};

const createEnterpriseDomains = async (user, primaryDomain) => {
  // Enterprise users typically have 1-5 domains
  const domainCount = Math.floor(Math.random() * 5) + 1;
  const domains = [primaryDomain];
  
  // Add additional domains for larger enterprises
  if (domainCount > 1) {
    for (let i = 1; i < domainCount; i++) {
      const additionalDomain = `${falso.randDomainName()}.${falso.randDomainSuffix()}`;
      domains.push(additionalDomain);
    }
  }
  
  for (const domainName of domains) {
    try {
      // Check if domain already exists
      const existingDomain = await Domains.findOne({ name: domainName });
      if (existingDomain) {
        console.log(`Domain ${domainName} already exists, skipping...`);
        continue;
      }
      
      const domainData = {
        name: domainName,
        members: [{
          user: user._id,
          group: 'admin'
        }],
        plan: user.plan,
        has_mx_record: Math.random() < 0.9, // 90% have MX records set up
        has_txt_record: Math.random() < 0.9, // 90% have TXT records set up
        has_dkim_record: Math.random() < 0.8, // 80% have DKIM set up
        smtp_port: Math.random() < 0.5 ? 587 : 465,
        created_at: dayjs(user.created_at).add(falso.randNumber({ min: 1, max: 7 }), 'days').toDate()
      };
      
      await Domains.create(domainData);
      console.log(`  Created domain: ${domainName}`);
    } catch (err) {
      console.error(`Error creating domain ${domainName}:`, err.message);
    }
  }
};

const createEnterprisePayments = async (user) => {
  // Enterprise users typically have 1-8 payments (subscriptions + one-time)
  const paymentCount = Math.floor(Math.random() * 8) + 1;
  
  for (let i = 0; i < paymentCount; i++) {
    try {
      const kind = Math.random() < 0.7 ? 'subscription' : 'one-time';
      const method = user.stripe_customer_id ? 'card' : (user.paypal_payer_id ? 'paypal' : 'card');
      
      // Enterprise payment amounts (higher than regular users)
      const amounts = user.plan === 'team' 
        ? [2999, 4999, 9999, 19999, 29999] // Team plan amounts
        : [999, 1999, 2999, 4999]; // Enhanced protection amounts
      
      const amount = amounts[Math.floor(Math.random() * amounts.length)];
      
      // Payment date within the last 2 years
      const paymentDate = falso.randPastDate({ years: 2 });
      
      const paymentData = {
        user: user._id,
        amount,
        currency: 'usd',
        plan: user.plan,
        kind,
        method,
        duration: ms('1y'), // Annual subscriptions typical for enterprise
        invoice_at: paymentDate,
        created_at: paymentDate,
        updated_at: paymentDate,
        
        // Payment provider details
        stripe_payment_intent_id: method === 'card' && user.stripe_customer_id 
          ? `pi_${falso.randAlphaNumeric({ length: 24 }).join('')}` : null,
        paypal_transaction_id: method === 'paypal' && user.paypal_payer_id 
          ? falso.randAlphaNumeric({ length: 17 }).join('').toUpperCase() : null,
          
        // Card details for card payments
        last4: method === 'card' ? falso.randCreditCard().slice(-4) : null,
        exp_month: method === 'card' ? falso.randNumber({ min: 1, max: 12 }) : null,
        exp_year: method === 'card' ? falso.randNumber({ min: 2024, max: 2030 }) : null,
        
        // Receipt tracking
        receipt_sent_at: dayjs(paymentDate).add(falso.randNumber({ min: 1, max: 60 }), 'minutes').toDate()
      };
      
      await Payments.create(paymentData);
    } catch (err) {
      console.error(`Error creating payment for user ${user.email}:`, err.message);
    }
  }
  
  console.log(`  Created ${paymentCount} payments for ${user.email}`);
};

(async () => {
  try {
    await setupMongoose();

    console.log(`Generating ${ENTERPRISE_COUNT} enterprise accounts...`);
    console.log('This includes users, domains, and payment history.\n');

    for (let count = 0; count < ENTERPRISE_COUNT; count++) {
      // eslint-disable-next-line no-await-in-loop
      await createEnterpriseUser(count);
      
      // Add a small delay to avoid overwhelming the database
      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`\nSuccessfully generated ${ENTERPRISE_COUNT} enterprise accounts!`);
    console.log('Data includes:');
    console.log('- Enterprise users with team/enhanced_protection plans');
    console.log('- Company information and billing details');
    console.log('- Multiple domains per enterprise');
    console.log('- Payment history and subscriptions');
    console.log('- Realistic enterprise metrics for admin dashboard');
    
    process.exit(0);
  } catch (err) {
    console.error('Error generating enterprise data:', err);
    process.exit(1);
  }
})();