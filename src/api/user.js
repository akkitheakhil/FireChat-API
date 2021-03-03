const express = require('express');

const router = express.Router();
require('dotenv').config();
const admin = require('firebase-admin');
const cookieParser = require('cookie-parser');
const monk = require('monk');
const yup = require('yup');
const db = monk(process.env.MONGO_URI);
const contacts = db.get(process.env.MONGO_DB_CONTACTS);
const connections = db.get(process.env.MONGO_DB_FRIENDREQUEST);
const Pusher = require("pusher");

contacts.createIndex('email');
connections.createIndex('email');

// Firebase Config
admin.initializeApp({
  credential: admin.credential.cert({
    "type": process.env.FIREBASE_TYPE,
    "project_id": process.env.FIREBASE_PROJECT_ID,
    "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
    "private_key": process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    "client_email": process.env.FIREBASE_CLIENT_EMAIL,
    "client_id": process.env.FIREBASE_CLIENT_ID,
    "auth_uri": process.env.FIREBASE_AUTH_URI,
    "token_uri": process.env.FIREBASE_TOKEN_URI,
    "auth_provider_x509_cert_url": process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
    "client_x509_cert_url": process.env.FIREBASE_CLIENT_X509_CERT_URL,
  }),
});

// Pusher Config
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSER,
  useTLS: true,
  encryptionMasterKey: process.env.PUSHER_CHANNELS_ENCRYPTION_KEY
});


// Firebase AuthCheck
function checkAuth(req, res, next) {

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    const idToken = req.headers.authorization.split('Bearer ')[1];
    admin.auth().verifyIdToken(idToken)
      .then((data) => {
        currentUser = data;
        req['currentUser'] = data;
        next()
      }).catch(() => {
        res.status(403).send({ errorStatus: 'Unauthorized', message: 'User not logged in or not a valid user' })
      });
  } else {
    res.status(403).send({ errorStatus: 'Unauthorized', message: 'User not logged in or not a valid user' })
  }
}

// Router Init
router.use(cookieParser());
router.use('/', checkAuth);


// Schemas
const userContacts = yup.object().shape({
  email: yup.string().email().trim().required(),
  contacts: yup.array().of(yup.object().shape({
    displaName: yup.string().trim().required(),
    email: yup.string().email().trim().required(),
    uid: yup.string().trim().required(),
  })),
});


// Pusher Authentication
router.post("/pusher/auth", async (req, res, next) => {
  let {socket_id, channel_name } = req.body;
  try {
    const currentUser = req.currentUser;
    console.log(req.body);
    console.log('channel name',channel_name);
    if(channel_name !== `private-encrypted-${req.currentUser.uid}`) throw Error('Unauthorized');
    const auth = pusher.authenticate(socket_id, channel_name);
    res.send(auth);
  } catch (err) {
    next(err);
  }
});



// Send friend request
router.post('/sendFriendReq', async (req, res, next) => {
  let { email } = req.body;
  try {
    console.log(email);
    const currentUser = req.currentUser;
    const currentUserEmail = req.currentUser.email;
    if(currentUserEmail === email) throw Error('You cannot send request to yourself');
    const user = await admin.auth().getUserByEmail(email);
    const existing = await contacts.findOne({ email: currentUserEmail });
    const requested = await connections.findOne({ requestedUserEmail: currentUserEmail, email: user.email});
    if (existing) {
      const isConnected = existing.contacts.find(user => user.email === user.email);
      if(isConnected) throw Error('Already connected');
    }
    if(requested) throw Error('Request already send');
    const connectReq = { uid: user.uid, email: user.email, requestedUserId: currentUser.uid, requestedUserName: currentUser.name, requestedUserEmail: currentUser.email };
    const created = await connections.insert(connectReq);
    pusher.trigger('private-encrypted-'+user.uid, "recieve-friend-request", created);
    res.json(created);
  } catch (err) {
    next(err);
  }
});

router.post('/dismissFriendReq', async (req, res, next) => {
  let { _id } = req.body;
  try {
    const remove = await connections.remove({_id});
    res.json(remove);
  } catch (err) {
    next(err);
  }
});

// Get all friend request received
router.get('/getConnectionRequests', async (req, res, next) => {
  try {
    const currentUser = req.currentUser;
    const allReq = await connections.find({ email: currentUser.email }) // equivalent
    console.log(allReq)
    res.json(allReq);
  } catch (err) {
    next(err);
  }
});

// Accept friend Request
router.post('/acceptFriendReq', async (req, res, next) => {
  let { _id } = req.body;
  try {
    const currentUser = req.currentUser;
    const friendReqInfo = await connections.findOne({ _id });
    if (!friendReqInfo) throw Error('No request info found');
    const existing = await contacts.findOne({ email: currentUser.email });
    const contactData = { displayName: friendReqInfo.requestedUserName, email: friendReqInfo.requestedUserEmail, uid: friendReqInfo.requestedUserId};
    let result;
    if (existing) {
      existing.contacts.push(contactData);
      result = await contacts.update({
        _id: existing._id
      }, {
        $set: existing
      });
      const remove = await connections.remove({_id});
    } else {
      const data = { email: currentUser.email, contacts: [contactData] }
      result= await contacts.insert(data);
      const remove = await connections.remove({_id});
    }

    const sendUsersList = await contacts.findOne({ email: friendReqInfo.requestedUserEmail });
    const contactUserData = { displayName: currentUser.name, email: currentUser.email, uid: currentUser.uid };

    if (sendUsersList) {
      sendUsersList.contacts.push(contactUserData);
      await contacts.update({
        _id: sendUsersList._id
      }, {
        $set: sendUsersList
      });
      res.json(updated);
    } else {
      const data = { email: friendReqInfo.requestedUserEmail, contacts: [contactUserData] }
      await contacts.insert(data);
      await connections.remove({_id});
    }
    pusher.trigger('private-encrypted-'+friendReqInfo.requestedUserId, "recieve-request-accepted", {message: 'accepted'});
    res.json(result);
  } catch (err) {
    next(err);
  }
})

// Get all contacts
router.get('/contacts', async (req, res, next) => {
  try {
    const currentUser = req.currentUser;
    const allReq = await contacts.findOne({ email: currentUser.email }) 
    res.json(allReq);
  } catch (err) {
    next(err);
  }
});


// Send Message
router.post('/sendMessage', async (req, res, next) => {
  let { message, recieverId, recieverEmail } = req.body;
  try {
    const currentUser = req.currentUser;
    const allReq = await contacts.findOne({ email: currentUser.email });
    const isFriend = allReq.contacts.find(contact => contact.email === recieverEmail);
    const isUserExist = await contacts.findOne({ email: recieverEmail });
    const isUsersFriend = isUserExist.contacts.find(contact => contact.email === currentUser.email);
    if(!isFriend || !isUsersFriend) throw Error('You are not connected to send messages');
    const createMessage = { message, recieverId, recieverEmail, senderId: currentUser.uid, senderEmail: currentUser.email, senderDisplayName: currentUser.name, timeStamp: new Date() }
    pusher.trigger('private-encrypted-'+recieverId, "recieve-messages", createMessage);
    res.json(createMessage);
  } catch (err) {
    next(err);
  }
});

router.post('/findContact', async (req, res, next) => {
  let { email } = req.body;
  try {
    const currentUser = req.currentUser;
    if(email === currentUser.email) throw Error('Same User')
    const user = await admin.auth().getUserByEmail(email);
    const allReq = await contacts.findOne({ email: currentUser.email });
    const requested = await connections.findOne({ requestedUserEmail: currentUser.email, email});
    let friendData;
    if(allReq && allReq.contacts.length > 0) friendData = allReq.contacts.find(contact => contact.email === email);
    const isFriend = (friendData !== null && friendData);
    const hasRequested = requested !== null;
    const response = { uid: user.uid, email: user.email, displayName: user.displayName, photoURL: user.providerData[0].photoURL, isFriend, hasRequested};
    //, 
    res.json(response);
  } catch (err) {
    next(err);
  }
});



module.exports = router;
