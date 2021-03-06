/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const 
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),  
  request = require('request'),
  fetch = require('node-fetch');

var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

/*
 * Be sure to setup your config values before running this code. You can 
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? 
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

// URL where the app is running (include protocol). Used to point to scripts and 
// assets located at this address. 
const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

const APP_ID = (process.env.APP_ID) ? 
  (process.env.APP_ID) :
  config.get('appID');  

const PAGE_ID = (process.env.PAGE_ID) ?
  (process.env.PAGE_ID) :
  config.get('pageID');

const WEATHER_APP_ID = (process.env.WEATHER_APP_ID) ?
  (process.env.WEATHER_APP_ID) :
  config.get('weatherAppID');

const LOCATIONS_BACKLOG_LIMIT = 3;

console.log("APP_SECRET: " + APP_SECRET);
console.log("VALIDATION_TOKEN: " + VALIDATION_TOKEN);
console.log("PAGE_ACCESS_TOKEN: " + PAGE_ACCESS_TOKEN);
console.log("SERVER_URL: " + SERVER_URL);

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

var DEFAULT_USERNAME = "friend";

var idCache = {};
var infoCache = {}; // map of city name to info
var locationsCache = {}; // map of id to most recent 3 locations requested
var hasPendingMsgs = {};

// Test web-plugin entry for Messenger Bot
app.get('/enter', function(req, res) {
  console.log("Rendering entry-point page");
  res.render('enter', {
   appId : APP_ID,
   //pageId : PAGE_ACCESS_TOKEN,
   pageId : PAGE_ID,
   pageAccessToken : PAGE_ACCESS_TOKEN,
   dataRef : "ABC123"// Use crypto module to generate some random hash?
  });
});


/*
app.get('/', function(req, res) {
  console.log("Redirecting to enter page!");
  res.redirect('/enter');
});
*/

/*
 * Use your own validation token. Check that the token used in the Webhook 
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});


/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've 
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL. 
 * 
 */
app.get('/authorize', function(req, res) {
  var accountLinkingToken = req.query.account_linking_token;
  var redirectURI = req.query.redirect_uri;

  // Authorization Code should be generated per user by the developer. This will 
  // be passed to the Account Linking callback.
  var authCode = "1234567890";

  // Redirect users to this URI on successful login
  var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

  res.render('authorize', {
    accountLinkingToken: accountLinkingToken,
    redirectURI: redirectURI,
    redirectURISuccess: redirectURISuccess
  });
});




/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the 
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger' 
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam, 
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  //sendTextMessage(senderID, "Authentication successful");
  console.log("Recipient ID is " + recipientID);
  sendTextMessage(senderID, "Hello friend!");
  // Extract username from recipient ID for custom greeting
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message' 
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some 
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've 
 * created. If we receive a message with an attachment (image, video, audio), 
 * then we'll simply confirm that we've received the attachment.
 * 
 */
function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    //sendTextMessage(senderID, "Quick reply tapped");
    handleQuickReply(senderID, quickReplyPayload);
    return;
  }

  if (messageText) {

    // If we receive a text message, check to see if it matches any special
    // keywords and send back the corresponding example. Otherwise, just echo
    // the text we received.
    switch (messageText) {
      case 'image':
        sendImageMessage(senderID);
        break;

      case 'gif':
        sendGifMessage(senderID);
        break;

      case 'audio':
        sendAudioMessage(senderID);
        break;

      case 'video':
        sendVideoMessage(senderID);
        break;

      case 'file':
        sendFileMessage(senderID);
        break;

      case 'button':
        sendButtonMessage(senderID);
        break;

      case 'generic':
        sendGenericMessage(senderID);
        break;

      case 'receipt':
        sendReceiptMessage(senderID);
        break;

      case 'quick reply':
        sendQuickReply(senderID);
        break;        

      case 'read receipt':
        sendReadReceipt(senderID);
        break;        

      case 'typing on':
        sendTypingOn(senderID);
        break;        

      case 'typing off':
        sendTypingOff(senderID);
        break;        

      case 'account linking':
        sendAccountLinking(senderID);
        break;

      default:
        //sendTextMessage(senderID, messageText);
        // parse the zipcode and country code, then fetch corresponding json
        fetchWeatherInfo(messageText, function(resultJSON) {
          sendWeatherInfo(senderID, resultJSON);
        }); // Parses zipcode and country code, then tries to fetch corresponding info
        //sendWeatherInfo(senderID, resultJSON);
    
    }
  } else if (messageAttachments) {
    sendTextMessage(senderID, "Message with attachment received");
  }
  console.log("Done handling received message!");
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Received delivery confirmation for message ID: %s", 
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);

  sendPendingMsg(senderID);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback 
  // button for Structured Messages. 
  var payload = event.postback.payload;

  console.log("Received postback for user %d and page %d with payload '%s' " + 
    "at %d", senderID, recipientID, payload, timeOfPostback);

  // When a postback is called, we'll send a message back to the sender to 
  // let them know it was successful

  var userName = DEFAULT_USERNAME;
  

  //var firstQn = "Please enter the city and country code for the place whose weather you want to know! For instance, 'menlo park, us'";

  if (!lookup(senderID)) { // First postback from this user, must be entry of user to app

  
    // Try to retrieve user info
    fetch('https://graph.facebook.com/v2.6/' + senderID + '?access_token=' + PAGE_ACCESS_TOKEN)
      .then(function(res) {
          return res.json();
      }).then(function(json) {
          console.log("User info received!\n"  + JSON.stringify(json));
          userName = json["first_name"] || userName;
          //sendTextMessage(senderID, "Welcome " + userName + "! " + firstQn);
          // Start by asking quick reply qn of whether you want to check out weather
          sendInitialQuickReply(senderID, userName);
          cache(senderID, userName);
      }).catch(function(err) { // in case there were network errors
        console.log("Error fetching user profile!\n" + err);
        sendTextMessage(senderID, "Welcome " + userName + "! " + firstQn); // TEMP - Replace with initial greeting or sequence from Wit.ai
      });
  }

  else {
    console.log("Postback received from existing user!");
    // Send buttons with past location info
    var favLocs = getCachedLocations(senderID);
    if (favLocs) { // send generic message with a button for every location
      var buttons = favLocs.map(function(loc) {
        return {
          type: "postback",
          title: loc,
          payload: loc,
        };
      });
    var elements = [{title: "Wanna check out the weather of one of your favorite locations?", buttons: buttons}];
    sendMessageWithGenericPayload(senderID, elements);
    }
    else {
      console.log("No locations found for this user! Trying to send inital question.");
      sendInitialQuickReply(senderID, lookup(senderID));
    }
  }

  //sendTextMessage(senderID, "Postback called");
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log("Received message read event for watermark %d and sequence " +
    "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log("Received account link event with for user %d with status %s " +
    "and auth code %s ", senderID, status, authCode);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/rift.png"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + "/assets/instagram_logo.gif"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "audio",
        payload: {
          url: SERVER_URL + "/assets/sample.mp3"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 *
 */
function sendVideoMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "video",
        payload: {
          url: SERVER_URL + "/assets/allofus480.mov"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a file using the Send API.
 *
 */
function sendFileMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "file",
        payload: {
          url: SERVER_URL + "/assets/test.txt"
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "This is test text",
          buttons:[{
            type: "web_url",
            url: "https://www.oculus.com/en-us/rift/",
            title: "Open Web URL"
          }, {
            type: "postback",
            title: "Trigger Postback",
            payload: "DEVELOPER_DEFINED_PAYLOAD"
          }, {
            type: "phone_number",
            title: "Call Phone Number",
            payload: "+16505551234"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a Structured Message (Generic Message type) using the Send API.
 *
 */
function sendGenericMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: "rift",
            subtitle: "Next-generation virtual reality",
            item_url: "https://www.oculus.com/en-us/rift/",               
            image_url: SERVER_URL + "/assets/rift.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/rift/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for first bubble",
            }],
          }, {
            title: "touch",
            subtitle: "Your Hands, Now in VR",
            item_url: "https://www.oculus.com/en-us/touch/",               
            image_url: SERVER_URL + "/assets/touch.png",
            buttons: [{
              type: "web_url",
              url: "https://www.oculus.com/en-us/touch/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "Call Postback",
              payload: "Payload for second bubble",
            }]
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Send a receipt message using the Send API.
 *
 */
function sendReceiptMessage(recipientId) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random()*1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message:{
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: "Peter Chang",
          order_number: receiptId,
          currency: "USD",
          payment_method: "Visa 1234",        
          timestamp: "1428444852", 
          elements: [{
            title: "Oculus Rift",
            subtitle: "Includes: headset, sensor, remote",
            quantity: 1,
            price: 599.00,
            currency: "USD",
            image_url: SERVER_URL + "/assets/riftsq.png"
          }, {
            title: "Samsung Gear VR",
            subtitle: "Frost White",
            quantity: 1,
            price: 99.99,
            currency: "USD",
            image_url: SERVER_URL + "/assets/gearvrsq.png"
          }],
          address: {
            street_1: "1 Hacker Way",
            street_2: "",
            city: "Menlo Park",
            postal_code: "94025",
            state: "CA",
            country: "US"
          },
          summary: {
            subtotal: 698.99,
            shipping_cost: 20.00,
            total_tax: 57.67,
            total_cost: 626.66
          },
          adjustments: [{
            name: "New Customer Discount",
            amount: -50
          }, {
            name: "$100 Off Coupon",
            amount: -100
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "What's your favorite movie genre?",
      quick_replies: [
        {
          "content_type":"text",
          "title":"Action",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_ACTION"
        },
        {
          "content_type":"text",
          "title":"Comedy",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_COMEDY"
        },
        {
          "content_type":"text",
          "title":"Drama",
          "payload":"DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_DRAMA"
        }
      ]
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  console.log("Sending a read receipt to mark message as seen");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "mark_seen"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  console.log("Turning typing indicator on");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  console.log("Turning typing indicator off");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons:[{
            type: "account_link",
            url: SERVER_URL + "/authorize"
          }]
        }
      }
    }
  };  

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s", 
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });  
}

function sendMessageWithGenericPayload(recipientId, elements) {
   var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: elements
        }
      }
    }
  };  
 callSendAPI(messageData);
}


function sendMessageWithImage(recipientId, imageURL) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: SERVER_URL + imageURL
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * Send a text message with a button using the Send API.
 *
 */
function sendMessageWithButton(recipientId, buttonInfo) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      //text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA",
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "This is a nice picture!",
          buttons: buttonInfo
        }
    }

  },
    //buttons: buttonInfo
};
  callSendAPI(messageData);
}


function sendInitialQuickReply(senderID, userName) {
  var qn = "Hello there " + userName + "! Would you like to check out today's weather for some location?";
  var quickReplies = [{content_type: "text", title: "Yes, please!", payload: "Start Weather"}, {content_type: "text", title: "No, thanks!", payload: "No Weather"}];
  sendMessageWithQuickReply(senderID, qn, quickReplies);
}

function sendMessageWithQuickReply(recipientId, qn, quickReplies) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: qn,
      quick_replies: quickReplies
    }
  };

  callSendAPI(messageData);
}

function sendFollowUpQuickReply(senderID) {
  var qn = "Would you like to check out the weather forecast for another location?";
  var quickReplies = [{content_type: "text", title: "Yes!", payload: "Yes"}, {content_type: "text", title: "No, thank you", payload: "No"}];
  sendMessageWithQuickReply(senderID, qn, quickReplies);
}


function handleQuickReply(senderID, quickReplyPayload) {
  if (quickReplyPayload === "Yes") { // User wants to ask about another location's weather
    console.log("User replied yes to quick reply, about to prompt for another location");
    var nextWeatherPrompt = "Ask away!";
    sendTextMessage(senderID, nextWeatherPrompt);
  }
  else if (quickReplyPayload == "No") { // User not interested in weather anymore, either exit or make small talk
    console.log("User replied no to quick reply, about to send quick reply for next action");
    var nextActionPrompt = "What would you like to do next?";
    var quickReplies = [{content_type: "text", title: "Chit-chat :)", payload: "chat"}, {content_type: "text", title: "Bid Farewell", payload: "exit"}];
    sendMessageWithQuickReply(senderID, nextActionPrompt, quickReplies);
  }
  else if (quickReplyPayload === "chat") { // user wants to make small talk
    console.log("User wants to chat... Wit.ai time!!!");
    //sendTextMessage(senderID, "hang on....");
    // TO-DO: Wit.ai stuff
    /*
    var testButtons = [{"type":"web_url",
        "url":"https://images.pexels.com/photos/104827/cat-pet-animal-domestic-104827.jpeg?w=940&h=650&auto=compress&cs=tinysrgb",
        "title":"A Cute Kitten",
        "webview_height_ratio": "compact"}];
    */
    //sendMessageWithButton(senderID, testButtons);
    //sendMessageWithImage(senderID, "/assets/kitten.png");
    var elements = [{
            title: "The OFFICIAL source of weather info",
            subtitle: "Don't trust a bot? Get it from the horse's mouth ;)",
            item_url: "https://weather.com/",               
            image_url: SERVER_URL + "/assets/weather.png",
            buttons: [{
              type: "web_url",
              url: "https://weather.com/",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "I like this!",
              payload: "like_weather",
            }], 
          },
          {
            title: "Random Cat pic :D",
            subtitle: "Bored of weather? Check out some cute cat pics :P",
            item_url: "https://www.buzzfeed.com/expresident/best-cat-pictures?utm_term=.vhMOaNJX6b#.ivvE3r6NAZ",               
            image_url: SERVER_URL + "/assets/kitten.png",
            buttons: [{
              type: "web_url",
              url: "https://www.buzzfeed.com/expresident/best-cat-pictures?utm_term=.vhMOaNJX6b#.ivvE3r6NAZ",
              title: "Open Web URL"
            }, {
              type: "postback",
              title: "This is awesome!",
              payload: "like_cat",
            }], 
          }];
    sendMessageWithGenericPayload(senderID, elements);
  }
  else if (quickReplyPayload === "Start Weather") { // send initial weather prompt
    var firstQn = "Please enter the city and country code for the place whose weather you want to know! For instance, 'menlo park, us'";
    sendTextMessage(senderID, firstQn);
  }
  else if (quickReplyPayload === "No Weather") { // handle same way as "No" above (TO-DO : Refactor into function)
    var nextActionPrompt = "What would you like to do then?";
    var quickReplies = [{content_type: "text", title: "Chit-chat :)", payload: "chat"}, {content_type: "text", title: "Bid Farewell", payload: "exit"}];
    sendMessageWithQuickReply(senderID, nextActionPrompt, quickReplies);
  }
  else { // user wants to exit.... say goodbye and provide logout link?
    console.log("User wants to exit... phew!");
    var userName = lookup(senderID) || DEFAULT_USERNAME;
    sendTextMessage(senderID, "Adios " + userName + "!");
    // TO-DO : Display Log-Out link
  }
}

// If there is a quick-reply waiting to be sent, send it; else nothing
function sendPendingMsg(senderID) {
  if (!hasPendingMsgs[senderID]) {
    console.log("No pending quick-replies for user " + senderID);
    return;
  }
  console.log("User " + senderID + " has pending quick reply!");
  sendFollowUpQuickReply(senderID);
  hasPendingMsgs[senderID] = false;
}
/*
function fetchWeatherInfo(inputText, next) {
  var num_regexp = /[0-9]+/;
  var letter_regexp = /[a-z]+/;
  var zipcode = inputText.match(num_regexp);
  if (!zipcode || zipcode.length == 0) {
    console.log("Missing zipcode, not going to fetch");
    //return null;
    return next(null);
  }
  var zip = zipcode[0];
  var countrycode = inputText.match(letter_regexp);
  if (!countrycode || countrycode.length == 0) {
    console.log("Missing countrycode, not going to fetch");
    //return null;
    return next(null);
  }
  var country = countrycode[0];
  var queryPrefix = "http://samples.openweathermap.org/data/2.5/weather?";
  var querySuffix = "&appid=" + WEATHER_APP_ID;
  var queryStr = queryPrefix + "zip=" + zip + "," + country + querySuffix;
  console.log("About to make query " + queryStr);
  fetch(queryStr)
  .then(function(res) {
    return res.json();
  }).then(function(json) {
    console.log("Obtained the following info:\n" + JSON.stringify(json));
    next(json);
    //return json;
  }).catch(function(err) {
    console.log("Error making weather query! " + err);
    //return null;
    return next(null);
  });
}
*/
function fetchWeatherInfo(inputText, next) {
  var splitRegExp = /,( )*/;
  var components = inputText.split(splitRegExp);
  const EXPECTED_COMPONENTS = 3;
  if (components.length != EXPECTED_COMPONENTS) {
    console.log("Badly formatted input");
    return next(null);
  }
  var city = components[0];
  var country = components[2];

  // Fetch from cache if possible
  var cacheRes;
  if ((cacheRes = getCachedInfo(city, country))) {
    console.log("Cache hit on " + city + ", " + country + "!");
    return next(cacheRes);
  }
  console.log("Cache miss on " + city + ", " + country);
  var query = 'https://query.yahooapis.com/v1/public/yql?q=select%20*%20from%20weather.forecast%20where%20woeid%20in%20(select%20woeid%20from%20geo.places(1)%20where%20text%3D%22' + encodeURI(city + ", " + country) + '%22)&format=json&env=store%3A%2F%2Fdatatables.org%2Falltableswithkeys';
  console.log("queryString is " + query);
  fetch(query)//, {method: 'GET', body: String})
    .then(
      response => {
        if (!response.ok) {
          console.log("Non-success status code while fetching!"); 
          throw new Error("Error status code from API");
        }
      return response.json();
    })
    .then(data => {
      console.log(`JSON data: ${JSON.stringify(data)}`)
      let low = data["query"]["results"]["channel"]["item"]["forecast"][0]["low"];
      let high = data["query"]["results"]["channel"]["item"]["forecast"][0]["high"];
      let text = data["query"]["results"]["channel"]["item"]["forecast"][0]["text"];
      let city = data["query"]["results"]["channel"]["location"]["city"];
      console.log(`Extracted low of ${low}, high of ${high}, text of ${text} for ${city}`);
      //this._update(true, {low, high, text, city});
      return next({low:low, high:high, text:text, city:city, country:country});
    })
    .catch(e => {
      console.log(`Error fetching! ${e}`);
      return next(null);
      //this._update(false);
    });
    console.log("Awaiting fetch");
}

/*
function sendWeatherInfo(senderID, info) {
  var errorMsg = "Sorry, I got nothing for that zipcode/countrycode combo. Check if it's valid?";
  if (!info || !info['weather'] || info['weather'].length == 0) {
    console.log("Missing info!");
    sendTextMessage(senderID, errorMsg);
    return;
  }
  var chosenInfo = info['weather'][0]['description'] || errorMsg;
  console.log("Info to send user: " + chosenInfo);
  sendTextMessage(senderID, chosenInfo);
}
*/
function sendWeatherInfo(senderID, info) {
  var errorMsg = "Sorry, I got nothing for that city/country combo. Check if it's valid?";
  if (!info) {
    console.log("Missing info!");
    sendTextMessage(senderID, errorMsg);
    return;
  }
  var infoMsg = info['city'] + " will experience " + info['text'] + " weather with a low of " + info['low'] + "F and a high of " + info['high'] + "F";
  //sendTextMessage(senderID, infoMsg);
  // TEMP
  sendTextMessage(senderID, infoMsg);
  /*
  var testButtons = [{"type":"web_url",
        "url":"https://images.pexels.com/photos/104827/cat-pet-animal-domestic-104827.jpeg?w=940&h=650&auto=compress&cs=tinysrgb",
        "title":"A Cute Kitten",
        "webview_height_ratio": "compact"}];
  sendMessageWithButton(senderID, testButtons);
  */
  // Mark user as having pending quick-reply
  hasPendingMsgs[senderID] = true;
  // Put in infoCache
  cacheInfo(info);
  // Put in locationsCache
  cacheLocations(senderID, info);
}

function cache(senderID, userName) {
  idCache[senderID] = userName;
}

function lookup(senderID) {
  return idCache[senderID];
}

// Need to clear cache at end of day
function cacheInfo(info) {
  infoCache[(info['city'] + ', ' + info['country']).toLowerCase()] = info;
  console.log("Added " + (info['city'] + ', ' + info['country']).toLowerCase() + " to cache with info of " + JSON.stringify(info));
  // TO-DO : Reset age of info
}

function getCachedInfo(city, country) {
  return infoCache[(city + ', ' + country).toLowerCase()];
}

function cacheLocations(senderID, info) {
  var currentLocs = locationsCache[senderID] || [];
  //var currentInfo = infoCache[]
  if (currentLocs.indexOf(info['city'] + ', ' + info['country']) == -1) { // location not there
    if (currentLocs.length >= LOCATIONS_BACKLOG_LIMIT) {
      currentLocs.shift();
    }
    currentLocs.push(info['city'] + ', ' + info['country']);
  }
  locationsCache[senderID] = currentLocs;
}

function getCachedLocations(senderID) {
  return locationsCache[senderID];
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid 
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;

