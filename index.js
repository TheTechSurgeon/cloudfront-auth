'use strict';
const qs = require('querystring');
const https = require('https');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const url = require('url');
const jwkToPem = require('jwk-to-pem');
const config = require('./config');
var discoveryDocument;
var jwks;

exports.handler = (event, context, callback) => {
  // Avoid unnecessary discovery document calls with container reuse
  if (jwks == null || discoveryDocument == null) {
    getDiscoveryDocumentData(event, context, callback);
  } else {
    processRequest(event, context, callback);
  }
};

function processRequest(event, context, callback) {
  // Get request, request headers, and querystring dictionary
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const queryDict = qs.parse(request.querystring);

  if (request.uri.startsWith('/_callback')) {
    // Verify code exists
    if (!queryDict.code) {
      unauthorized("No code found.", callback);
    }

    // ID token request data
    const postData = qs.stringify({
      'code': queryDict.code,
      'client_id': config.CLIENT_ID,
      'client_secret': config.CLIENT_SECRET,
      'redirect_uri': config.REDIRECT_URI,
      'grant_type': 'authorization_code'
    });

    // ID token request options
    const options = {
      hostname: 'www.googleapis.com',
      port: 443,
      path: '/oauth2/v4/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    // Send ID token request in exchange for code
    const req = https.request(options, (res) => {
      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        const parsedData = JSON.parse(rawData);
        const decodedData = jwt.decode(parsedData.id_token);
        try {
          if ("error" in decodedData) {
            unauthorized(decodedData.error_description, callback);
          } else {
            const response = {
              status: '302',
              statusDescription: 'Found',
              body: 'ID token retrieved.',
              headers: {
                location : [{
                  key: 'Location',
                  value: "https://bka.yden.us" + queryDict.state
                }],
                'set-cookie' : [{
                  key: 'Set-Cookie',
                  value : cookie.serialize('token', parsedData.id_token)
                }],
              },
            };
            callback(null, response);
          }
        } catch (e) {
          internalServerError(e.message, callback);
        }
      });
    });

    req.on('error', (e) => {
      internalServerError(e.message, callback);
    });

    // Write data to request body
    req.write(postData);
    req.end();
  } else if ("cookie" in headers
              && "token" in cookie.parse(headers["cookie"][0].value)) {
    var token = jwt.decode(cookie.parse(headers["cookie"][0].value).token, {complete: true});

    var pem = "";
    for (var i = 0; i < jwks.keys.length; i++) {
      if (token.header.kid === jwks.keys[i].kid) {
        pem = jwkToPem(jwks.keys[i]);
      }
    }
    jwt.verify(cookie.parse(headers["cookie"][0].value).token, pem, { algorithms: ['RS256'] }, function(err, decoded) {
      if (!err && token.payload.email_verified === true && token.payload.email.endsWith(config.HOSTED_DOMAIN)) {
        callback(null, request);
      } else {
        unauthorized('Unauthorized. User ' + token.payload.email + ' is not permitted.', callback);
      }
    });
  } else {
    // Form Google's OAuth 2.0 Server URL
    var querystring = qs.stringify({
      "client_id": config.CLIENT_ID,
      "redirect_uri": config.REDIRECT_URI,
      "scope": 'openid email',
      "hd": config.HOSTED_DOMAIN,
      "state": headers.host.find("Host") + request.uri,
      "response_type": "code"
    });

    const response = {
      status: '302',
      statusDescription: 'Found',
      body: 'Authenticating with Google',
      headers: {
          location : [{
              key: 'Location',
              value: discoveryDocument.authorization_endpoint + "?" + querystring
           }],
      },
    };
    callback(null, response);
  }
}

function unauthorized(body, callback) {
  const response = {
    status: '401',
    statusDescription: 'Unauthorized',
    body: body,
  };
  callback(null, response);
}

function internalServerError(body, callback) {
  const response = {
    status: '500',
    statusDescription: 'Internal Server Error',
    body: body,
  };
  callback(null, response);
}

function getDiscoveryDocumentData(event, context, callback) {
  // Get Discovery Document data
  const postData = "";
  const options = {
    hostname: 'accounts.google.com',
    port: 443,
    path: '/.well-known/openid-configuration',
    method: 'GET',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = https.request(options, (res) => {
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
      // Get jwks from discovery document url
      const parsedData = JSON.parse(rawData);
      try {
        discoveryDocument = parsedData;
        if (parsedData.hasOwnProperty('jwks_uri')) {
          // Get public key and verify JWT
          const postData = "";
          const keysUrl = url.parse(parsedData.jwks_uri);
          const options = {
            hostname: keysUrl.host,
            port: 443,
            path: keysUrl.path,
            method: 'GET',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(postData)
            }
          };

          const req = https.request(options, (res) => {
            let rawData = '';
            res.on('data', (chunk) => { rawData += chunk; });
            res.on('end', () => {
              jwks = JSON.parse(rawData);
              processRequest(event, context, callback);
            });
          });

          req.on('error', (e) => {
            internalServerError("Unable to verify JWT.", callback);
          });

          // Write data to request body
          req.write(postData);
          req.end();
        } else {
          internalServerError("Unable to verify JWT.", callback);
        }
      } catch (e) {
        internalServerError("Unable to verify JWT: " + e.message, callback);
      }
    });
  });

  req.on('error', (e) => {
    internalServerError("Unable to verify JWT: " + e.message, callback);
  });

  // Write data to request body
  req.write(postData);
  req.end();
}