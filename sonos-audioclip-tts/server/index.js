/*
The MIT License (MIT)

 Original Copyright 2018 Phil Nash
 Modifications and addtions Copyright (c) 2015 Sonos, Inc.

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in all
 copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 SOFTWARE.
 */

const express = require('express');
const bodyParser = require('body-parser');
const pino = require('express-pino-logger')();
const simpleOauthModule = require('simple-oauth2');
const googleTTS = require('google-tts-api');
const storage = require('node-persist');
const fs = require('fs');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(pino);

// Load Configuration
let rawconfig = fs.readFileSync('../../data/options.json');  
let config = JSON.parse(rawconfig);  

console.log("Starting with configuration:", config)

// Let's initialize our local storage to keep the auth token
// This way we don't have to log in every time the app restarts
storage.init({dir: '../../data/persist/'});


// This section services the OAuth2 flow
const oauth2 = simpleOauthModule.create({
  client: {
    id: config.SONOS_CLIENT_ID,
    secret: config.SONOS_CLIENT_SECRET,
  },
  auth: {
    tokenHost: 'https://api.sonos.com',
    tokenPath: '/login/v3/oauth/access',
    authorizePath: '/login/v3/oauth',
  },
});

// Authorization uri definition
const authorizationUri = oauth2.authorizationCode.authorizeURL({
  redirect_uri: 'https://hassio.local:8349/redirect',
  scope: 'playback-control-all',
  state: 'none',
});

// Get our token set up

let token; // This'll hold our token, which we'll use in the Auth header on calls to the Sonos Control API
let authRequired = false; // We'll use this to keep track of when auth is needed (first run, failed refresh, etc) and return that fact to the calling app so it can redirect

// This is a function we run when we first start the app. It gets the token from the local store, or sets authRequired if it's unable to
async function getToken() {
  const currentToken = await storage.getItem('token');
  if (currentToken === undefined) {
    authRequired = true;
    return;
  }
  token = oauth2.accessToken.create(currentToken.token);

  if (token.expired()) {
    try {
      token = await token.refresh();
      await storage.setItem('token',token); // And save it to local storage to capture the new access token and expiry date
    } catch (error) {
      authRequired = true;
      console.log('Error refreshing access token: ', error.message);
    }
  }
}

getToken();

// Initial page redirecting to Sonos
app.get('/auth', async (req, res) => {
  res.redirect(authorizationUri);
});

// redirect service parsing the authorization token and asking for the access token
app.get('/redirect', async (req, res) => {
  const code = req.query.code;
  const redirect_uri = 'https://hassio.local:8349/redirect';

  const options = {
    code,redirect_uri,
  };

  try {
    const result = await oauth2.authorizationCode.getToken(options);

    console.log('The resulting token: ', result);

    token = oauth2.accessToken.create(result); // Save the token for use in Sonos API calls

    await storage.setItem('token',token); // And save it to local storage for use the next time we start the app
    authRequired = false; // And we're all good now. Don't need auth any more
    res.send('Auth Complete');
  } catch(error) {
    console.error('Access Token Error', error.message);
    return res.status(500).json('Authentication failed');
  }
});

// This section services the front end.

// This route handler returns the available households for the authenticated user
app.get('/api/allClipCapableDevices', async (req, res) => {
  await getToken()
  res.setHeader('Content-Type', 'application/json');
  if (authRequired) {
    res.send(JSON.stringify({'success':false,authRequired:true}));
    return;
  }
  let hhResult;

  try {
    hhResult = await fetch(`https://api.ws.sonos.com/control/api/v1/households`, {
     method: 'GET',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.token.access_token}` },
    });
  }
  catch (err) {
    res.send(JSON.stringify({'success':false, error: err.stack}));
    return;
  }

// We convert to text rather than JSON here, since, on some errors, the Sonos API returns plain text
  const hhResultText = await hhResult.text();

// Let's try to immediately convert that text to JSON,
  try  {
    const json = JSON.parse(hhResultText);
    if (json.households !== undefined) { // if there's a households object, things went well, and we'll return that array of hhids
      let allClipCapableDevices = {}
      for (let household of json.households) {
        allClipCapableDevices[household.id] = []
        let groupsResult;
        try {
          groupsResult = await fetch(`https://api.ws.sonos.com/control/api/v1/households/${household.id}/groups`, {
           method: 'GET',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.token.access_token}` },
          });
        }
        catch (err) {
          console.log(err)
          continue;
        }

        const groupsResultText = await groupsResult.text();


        let groups;
        try  {
          groups = JSON.parse(groupsResultText);
          if (groups.groups === undefined) { // If there isn't a groups object, the fetch didn't work, and we'll let the caller know
            continue
          }
        }
        catch (err){
          console.log(err)
          continue
        }

        const players = groups.players; // Let's get all the clip capable players
        const clipCapablePlayers = [];
        for (let player of players) {
          if (player.capabilities.includes('AUDIO_CLIP')) {
            clipCapablePlayers.push({'id':player.id,'name':player.name});
          }
        }
        allClipCapableDevices[household.id] = clipCapablePlayers
      }
      res.send(JSON.stringify({'success':true, 'households': allClipCapableDevices}, null, '\t'));
    }
    else {
      res.send(JSON.stringify({'success': false, 'error':json.error}));
    }
  }
  catch (err){
    console.log(err)
    res.send(JSON.stringify({'success':false, 'error': hhResultText}));
  }

});

// // This route handler returns the available households for the authenticated user
// app.get('/api/households', async (req, res) => {
//   await getToken()
//   res.setHeader('Content-Type', 'application/json');
//   if (authRequired) {
//     res.send(JSON.stringify({'success':false,authRequired:true}));
//     return;
//   }
//   let hhResult;

//   try {
//     hhResult = await fetch(`https://api.ws.sonos.com/control/api/v1/households`, {
//      method: 'GET',
//       headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.token.access_token}` },
//     });
//   }
//   catch (err) {
//     res.send(JSON.stringify({'success':false,error: err.stack}));
//     return;
//   }

// // We convert to text rather than JSON here, since, on some errors, the Sonos API returns plain text
//   const hhResultText = await hhResult.text();

// // Let's try to immediately convert that text to JSON,
//   try  {
//     const json = JSON.parse(hhResultText);
//     if (json.households !== undefined) { // if there's a households object, things went well, and we'll return that array of hhids
//       res.send(JSON.stringify({'success': true, 'households':json.households}));
//     }
//     else {
//       res.send(JSON.stringify({'success': false, 'error':json.error}));
//     }
//   }
//   catch (err){
//     res.send(JSON.stringify({'success':false, 'error': hhResultText}));
//   }
// });

// // Here we'll get the list of speakers that are capable of playing audioClips
// // Note that the AUDIO_CLIP capability flag isn't implemented on the Sonos platform yet, so we have
// // to simply return all speakers for right now, and let the user figure out which ones work
// app.get('/api/clipCapableSpeakers', async (req, res) => {
//   await getToken()
//   const household = req.query.household;

//   res.setHeader('Content-Type', 'application/json');
//   if (authRequired) {
//     res.send(JSON.stringify({success:false,authRequired:true}));
//     return;
//   }

//   let groupsResult;

//   try {
//     groupsResult = await fetch(`https://api.ws.sonos.com/control/api/v1/households/${household}/groups`, {
//      method: 'GET',
//       headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.token.access_token}` },
//     });
//   }
//   catch (err) {
//     res.send(JSON.stringify({'success':false,error: err.stack}));
//     return;
//   }

//   const groupsResultText = await groupsResult.text();


//   let groups;
//   try  {
//     groups = JSON.parse(groupsResultText);
//     if (groups.groups === undefined) { // If there isn't a groups object, the fetch didn't work, and we'll let the caller know
//       res.send(JSON.stringify({'success': false, 'error':groups.error}));
//       return;
//     }
//   }
//   catch (err){
//     res.send(JSON.stringify({'success':false, 'error': groupsResultText}));
//     return;
//   }

//   const players = groups.players; // Let's get all the clip capable players
//   const clipCapablePlayers = [];
//   for (let player of players) {
//     if (player.capabilities.includes('AUDIO_CLIP')) {
//       clipCapablePlayers.push({'id':player.id,'name':player.name});
//     }
//   }
//   res.send(JSON.stringify({'success':true, 'players': clipCapablePlayers}));
// });

app.get('/api/speakText', async (req, res) => {
  await getToken()
  const text = req.query.text;
  const volume = req.query.volume;
  const playerId = req.query.playerId;

  const speakTextRes = res;
  speakTextRes.setHeader('Content-Type', 'application/json');
  if (authRequired) {
    res.send(JSON.stringify({'success':false,authRequired:true}));
  }

  if (text == null || playerId == null) { // Return if either is null
    speakTextRes.send(JSON.stringify({'success':false,error: 'Missing Parameters'}));
    return;
  }

  let speechUrl;

  try { // Let's make a call to the google tts api and get the url for our TTS file
    speechUrl = await googleTTS(text, config.GOOGLE_TTS_LANGUAGE, 1);
  }
  catch (err) {
    speakTextRes.send(JSON.stringify({'success':false,error: err.stack}));
    return;
  }

  let body = { streamUrl: speechUrl, name: 'Sonos TTS', appId: 'com.me.sonosspeech' };
  if(volume != null) {
    body.volume = parseInt(volume)
  }

  let audioClipRes;

  try { // And call the audioclip API, with the playerId in the url path, and the text in the JSON body
    audioClipRes = await fetch(`https://api.ws.sonos.com/control/api/v1/players/${playerId}/audioClip`, {
     method: 'POST',
      body:    JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.token.access_token}` },
    });
  }
  catch (err) {
    speakTextRes.send(JSON.stringify({'success':false,error: err.stack}));
    return;
  }

  const audioClipResText = await audioClipRes.text(); // Same thing as above: convert to text, since occasionally the Sonos API returns text

  try  {
    const json = JSON.parse(audioClipResText);
    if (json.id !== undefined) {
      speakTextRes.send(JSON.stringify({'success': true}));
    }
    else {
      speakTextRes.send(JSON.stringify({'success': false, 'error':json.errorCode}));
    }
  }
  catch (err){
    speakTextRes.send(JSON.stringify({'success':false, 'error': audioClipResText}));
  }
});

app.get('/api/playClip', async (req, res) => {
  await getToken()
  const streamUrl = req.query.streamUrl;
  const volume = req.query.volume;
  const playerId = req.query.playerId;

  const speakTextRes = res;
  speakTextRes.setHeader('Content-Type', 'application/json');
  if (authRequired) {
    res.send(JSON.stringify({'success':false,authRequired:true}));
  }

  if (streamUrl == null || playerId == null) { // Return if either is null
    speakTextRes.send(JSON.stringify({'success':false,error: 'Missing Parameters'}));
    return;
  }

  let body = { streamUrl: streamUrl, name: 'Sonos TTS', appId: 'com.me.sonosspeech' };
  if(volume != null) {
    body.volume = parseInt(volume)
  }

  let audioClipRes;

  console.log(body)

  try { // And call the audioclip API, with the playerId in the url path, and the text in the JSON body
    audioClipRes = await fetch(`https://api.ws.sonos.com/control/api/v1/players/${playerId}/audioClip`, {
     method: 'POST',
      body:    JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.token.access_token}` },
    });
  }
  catch (err) {
    speakTextRes.send(JSON.stringify({'success':false,error: err.stack}));
    return;
  }

  const audioClipResText = await audioClipRes.text(); // Same thing as above: convert to text, since occasionally the Sonos API returns text

  try  {
    const json = JSON.parse(audioClipResText);
    if (json.id !== undefined) {
      speakTextRes.send(JSON.stringify({'success': true}));
    }
    else {
      speakTextRes.send(JSON.stringify({'success': false, 'error':json.errorCode}));
    }
  }
  catch (err){
    speakTextRes.send(JSON.stringify({'success':false, 'error': audioClipResText}));
  }
});

app.listen(8349, () =>
  console.log('Express server is running on localhost:8349')
);
