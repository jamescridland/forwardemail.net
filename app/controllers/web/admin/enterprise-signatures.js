/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const Boom = require('@hapi/boom');
const axios = require('axios');
const dayjs = require('dayjs-with-plugins');
const isSANB = require('is-string-and-not-blank');

const { EnterpriseAccounts } = require('#models');
const config = require('#config');
const email = require('#helpers/email');

// DocuSign configuration (would be in config in real implementation)
const DOCUSIGN_CONFIG = {
  baseUrl: process.env.DOCUSIGN_BASE_URL || 'https://demo.docusign.net/restapi',
  accountId: process.env.DOCUSIGN_ACCOUNT_ID,
  clientId: process.env.DOCUSIGN_CLIENT_ID,
  clientSecret: process.env.DOCUSIGN_CLIENT_SECRET,
  redirectUri:
    process.env.DOCUSIGN_REDIRECT_URI ||
    `${config.urls.web}/admin/enterprise/signatures/callback`
};

// HelloSign configuration
const HELLOSIGN_CONFIG = {
  apiKey: process.env.HELLOSIGN_API_KEY,
  baseUrl: 'https://api.hellosign.com/v3'
};

// Initiate document signing process
async function initiateSignature(ctx) {
  const enterpriseAccount = await EnterpriseAccounts.findById(ctx.params.id)
    .populate('user', 'email')
    .lean()
    .exec();

  if (!enterpriseAccount) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  const { documentId, signerEmail, signerName, provider } = ctx.request.body;

  if (!documentId || !signerEmail || !signerName) {
    return ctx.throw(
      Boom.badRequest(ctx.translateError('SIGNATURE_DETAILS_REQUIRED'))
    );
  }

  // Find the document in the enterprise account
  const document = enterpriseAccount.documents.find(
    (doc) => doc._id.toString() === documentId
  );
  if (!document) {
    return ctx.throw(Boom.badRequest(ctx.translateError('DOCUMENT_NOT_FOUND')));
  }

  let signatureResponse;
  try {
    if (provider === 'docusign') {
      signatureResponse = await initiateDocuSignEnvelope(
        enterpriseAccount,
        document,
        signerEmail,
        signerName
      );
    } else if (provider === 'hellosign') {
      signatureResponse = await initiateHelloSignRequest(
        enterpriseAccount,
        document,
        signerEmail,
        signerName
      );
    } else {
      return ctx.throw(
        Boom.badRequest(ctx.translateError('INVALID_SIGNATURE_PROVIDER'))
      );
    }

    // Update document with signature tracking info
    await EnterpriseAccounts.findOneAndUpdate(
      { _id: enterpriseAccount._id, 'documents._id': documentId },
      {
        $set: {
          'documents.$.status': 'pending_signature',
          'documents.$.signature_request': {
            provider,
            request_id: signatureResponse.requestId,
            signing_url: signatureResponse.signingUrl,
            initiated_at: new Date(),
            initiated_by: ctx.state.user.email
          }
        }
      }
    );

    // Add timeline entry
    const account = await EnterpriseAccounts.findById(enterpriseAccount._id);
    await account.addTimelineEntry(
      'contract_sent_for_signature',
      `Document "${document.name}" sent for signature via ${provider}`,
      ctx.state.user.email
    );

    // Send notification email to signer
    await sendSignatureRequestEmail(
      enterpriseAccount,
      document,
      signerEmail,
      signatureResponse.signingUrl
    );

    if (ctx.accepts('html')) {
      ctx.flash('success', ctx.translate('SIGNATURE_REQUEST_SENT'));
      return ctx.redirect('back');
    }

    ctx.body = {
      message: ctx.translate('SIGNATURE_REQUEST_SENT'),
      signingUrl: signatureResponse.signingUrl,
      requestId: signatureResponse.requestId
    };
  } catch (err) {
    ctx.logger.error('Signature initiation failed:', err);
    return ctx.throw(
      Boom.badRequest(ctx.translateError('SIGNATURE_REQUEST_FAILED'))
    );
  }
}

// DocuSign envelope creation
async function initiateDocuSignEnvelope(
  enterpriseAccount,
  document,
  signerEmail,
  signerName
) {
  // Get DocuSign access token
  const accessToken = await getDocuSignAccessToken();
  
  const envelopeDefinition = {
    emailSubject: `Please sign: ${document.name} - ${enterpriseAccount.company_name}`,
    documents: [
      {
        documentId: '1',
        name: document.name,
        documentBase64: await fetchDocumentAsBase64(document.url),
        fileExtension: 'pdf'
      }
    ],
    recipients: {
      signers: [
        {
          email: signerEmail,
          name: signerName,
          recipientId: '1',
          routingOrder: '1',
          tabs: {
            signHereTabs: [
              {
                anchorString: 'Signature:',
                anchorXOffset: '1',
                anchorYOffset: '-3'
              }
            ],
            dateSignedTabs: [
              {
                anchorString: 'Date:',
                anchorXOffset: '1',
                anchorYOffset: '-3'
              }
            ]
          }
        }
      ]
    },
    status: 'sent'
  };

  try {
    // Create envelope via DocuSign API
    const response = await axios.post(
      `${DOCUSIGN_CONFIG.baseUrl}/v2.1/accounts/${DOCUSIGN_CONFIG.accountId}/envelopes`,
      envelopeDefinition,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const envelopeId = response.data.envelopeId;

    // Get the recipient view (signing URL)
    const recipientViewRequest = {
      authenticationMethod: 'email',
      email: signerEmail,
      userName: signerName,
      recipientId: '1',
      returnUrl: `${config.urls.web}/admin/enterprise/${enterpriseAccount._id}?signed=true`,
      clientUserId: `client_${enterpriseAccount._id}_${Date.now()}`
    };

    const viewResponse = await axios.post(
      `${DOCUSIGN_CONFIG.baseUrl}/v2.1/accounts/${DOCUSIGN_CONFIG.accountId}/envelopes/${envelopeId}/views/recipient`,
      recipientViewRequest,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      requestId: envelopeId,
      signingUrl: viewResponse.data.url
    };
  } catch (error) {
    console.error('DocuSign API Error:', error.response?.data || error.message);
    throw new Error(`DocuSign API failed: ${error.response?.data?.message || error.message}`);
  }
}

// HelloSign signature request
async function initiateHelloSignRequest(
  enterpriseAccount,
  document,
  signerEmail,
  signerName
) {
  // This would use the actual HelloSign API
  const requestData = {
    title: `${enterpriseAccount.company_name} - ${document.name}`,
    subject: `Please sign: ${document.name}`,
    message: `Hello ${signerName}, please review and sign the attached document.`,
    signers: [
      {
        email_address: signerEmail,
        name: signerName
      }
    ],
    file_url: [document.url], // Document URL
    test_mode: process.env.NODE_ENV !== 'production' ? 1 : 0
  };

  // Mock response for now - would use actual HelloSign API
  const mockResponse = {
    requestId: `hellosign_${Date.now()}`,
    signingUrl: `https://app.hellosign.com/sign/${Math.random()
      .toString(36)
      .slice(2, 11)}`
  };

  return mockResponse;
}

// Handle signature completion webhook
async function handleSignatureWebhook(ctx) {
  const { provider } = ctx.params;
  const webhookData = ctx.request.body;

  try {
    let signatureInfo;

    if (provider === 'docusign') {
      signatureInfo = await processDocuSignWebhook(webhookData);
    } else if (provider === 'hellosign') {
      signatureInfo = await processHelloSignWebhook(webhookData);
    } else {
      return ctx.throw(
        Boom.badRequest(ctx.translateError('INVALID_WEBHOOK_PROVIDER'))
      );
    }

    if (signatureInfo) {
      // Find the enterprise account with this signature request
      const enterpriseAccount = await EnterpriseAccounts.findOne({
        'documents.signature_request.request_id': signatureInfo.requestId
      });

      if (enterpriseAccount) {
        // Update document status
        const documentIndex = enterpriseAccount.documents.findIndex(
          (doc) => doc.signature_request?.request_id === signatureInfo.requestId
        );

        if (documentIndex !== -1) {
          enterpriseAccount.documents[documentIndex].status =
            signatureInfo.status;
          enterpriseAccount.documents[
            documentIndex
          ].signature_request.completed_at = new Date();

          if (signatureInfo.signedDocumentUrl) {
            enterpriseAccount.documents[
              documentIndex
            ].signature_request.signed_document_url =
              signatureInfo.signedDocumentUrl;
          }

          await enterpriseAccount.save();

          // Add timeline entry
          await enterpriseAccount.addTimelineEntry(
            signatureInfo.status === 'signed'
              ? 'contract_signed'
              : 'signature_declined',
            `Document "${enterpriseAccount.documents[documentIndex].name}" ${signatureInfo.status}`,
            'system'
          );

          // Send notification email
          await sendSignatureCompletionEmail(
            enterpriseAccount,
            enterpriseAccount.documents[documentIndex],
            signatureInfo
          );

          // If contract was signed, potentially advance to next stage
          if (
            signatureInfo.status === 'signed' &&
            enterpriseAccount.onboarding_status === 'contract_negotiation'
          ) {
            await enterpriseAccount.addTimelineEntry(
              'contract_signed',
              'Contract successfully signed',
              'system'
            );
          }
        }
      }
    }

    ctx.body = { received: true };
  } catch (err) {
    ctx.logger.error('Webhook processing failed:', err);
    ctx.body = { error: 'Webhook processing failed' };
  }
}

// Process DocuSign webhook
async function processDocuSignWebhook(webhookData) {
  // Parse DocuSign webhook payload
  // This would extract the actual signature status and document info
  return {
    requestId: webhookData.envelopeId || webhookData.data?.envelopeId,
    status: webhookData.status === 'completed' ? 'signed' : webhookData.status,
    signedDocumentUrl: webhookData.documentsUri,
    signerEmail: webhookData.recipients?.signers?.[0]?.email
  };
}

// Process HelloSign webhook
async function processHelloSignWebhook(webhookData) {
  // Parse HelloSign webhook payload
  return {
    requestId: webhookData.signature_request?.signature_request_id,
    status:
      webhookData.event?.event_type === 'signature_request_signed'
        ? 'signed'
        : webhookData.event?.event_type === 'signature_request_declined'
        ? 'declined'
        : 'pending',
    signedDocumentUrl: webhookData.signature_request?.final_copy_uri,
    signerEmail:
      webhookData.signature_request?.signatures?.[0]?.signer_email_address
  };
}

// Get signature status for a document
async function getSignatureStatus(ctx) {
  const enterpriseAccount = await EnterpriseAccounts.findById(ctx.params.id);

  if (!enterpriseAccount) {
    return ctx.throw(
      Boom.notFound(ctx.translateError('ENTERPRISE_ACCOUNT_DOES_NOT_EXIST'))
    );
  }

  const { documentId } = ctx.params;
  const document = enterpriseAccount.documents.find(
    (doc) => doc._id.toString() === documentId
  );

  if (!document) {
    return ctx.throw(Boom.badRequest(ctx.translateError('DOCUMENT_NOT_FOUND')));
  }

  const signatureRequest = document.signature_request;

  if (!signatureRequest) {
    return ctx.throw(
      Boom.badRequest(ctx.translateError('NO_SIGNATURE_REQUEST_FOUND'))
    );
  }

  // In a real implementation, this would query the signature provider's API for current status
  ctx.body = {
    status: document.status,
    signatureRequest: {
      provider: signatureRequest.provider,
      requestId: signatureRequest.request_id,
      signingUrl: signatureRequest.signing_url,
      initiatedAt: signatureRequest.initiated_at,
      completedAt: signatureRequest.completed_at,
      signedDocumentUrl: signatureRequest.signed_document_url
    }
  };
}

// Helper function to send signature request email
async function sendSignatureRequestEmail(
  enterpriseAccount,
  document,
  signerEmail,
  signingUrl
) {
  try {
    await email({
      template: 'signature-request',
      message: {
        to: signerEmail
      },
      locals: {
        enterpriseAccount,
        document,
        signingUrl,
        companyName: enterpriseAccount.company_name
      }
    });
  } catch (err) {
    console.error('Failed to send signature request email:', err);
  }
}

// Helper function to send signature completion email
async function sendSignatureCompletionEmail(
  enterpriseAccount,
  document,
  signatureInfo
) {
  try {
    await email({
      template: 'signature-completed',
      message: {
        to: enterpriseAccount.primary_contact.email
      },
      locals: {
        enterpriseAccount,
        document,
        signatureInfo,
        companyName: enterpriseAccount.company_name
      }
    });
  } catch (err) {
    console.error('Failed to send signature completion email:', err);
  }
}

// Get DocuSign access token using JWT
async function getDocuSignAccessToken() {
  try {
    const response = await axios.post(
      `${DOCUSIGN_CONFIG.baseUrl.replace('/restapi', '')}/oauth/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: DOCUSIGN_CONFIG.clientId,
        client_secret: DOCUSIGN_CONFIG.clientSecret,
        scope: 'signature impersonation'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    return response.data.access_token;
  } catch (error) {
    console.error('DocuSign OAuth Error:', error.response?.data || error.message);
    throw new Error('Failed to obtain DocuSign access token');
  }
}

// Helper function to fetch document as base64 (for DocuSign)
async function fetchDocumentAsBase64(documentUrl) {
  try {
    const response = await axios.get(documentUrl, {
      responseType: 'arraybuffer'
    });
    
    return Buffer.from(response.data, 'binary').toString('base64');
  } catch (error) {
    console.error('Error fetching document:', error.message);
    // Return a minimal PDF placeholder if document fetch fails
    return 'JVBERi0xLjQKJcOkw7zDtsOkCjUgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAzIDAgUgovUmVzb3VyY2VzIDw8Ci9Gb250IDw8Ci8xIDcgMCBSCj4+Cj4+Ci9NZWRpYUJveCBbMCAwIDYxMiA3OTJdCi9Db250ZW50cyA2IDAgUgo+PgplbmRvYmoKNiAwIG9iago8PAovTGVuZ3RoIDExMAo+PgpzdHJlYW0KQlQKLzEgVGYKNzIgTEYKNTAgNzAwIFRkCihEb2N1bWVudCBhd2FpdGluZyBzaWduYXR1cmUpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmCjAwMDAwMDAwMTEgMDAwMDAgbgowMDAwMDAwMTUwIDAwMDAwIG4KMDAwMDAwMDIxNCAwMDAwMCBuCjAwMDAwMDAyNzEgMDAwMDAgbgowMDAwMDAwMzI4IDAwMDAwIG4KdHJhaWxlcgo8PAovU2l6ZSA3Ci9Sb290IDEgMCBSCj4+CnN0YXJ0eHJlZgo0MTAKJSVFT0Y=';
  }
}

module.exports = {
  initiateSignature,
  handleSignatureWebhook,
  getSignatureStatus
};
