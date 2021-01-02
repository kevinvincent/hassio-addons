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
const { AuthorizationCode } = require('simple-oauth2');
const googleTTS = require('google-tts-api');
const storage = require('node-persist');
const fs = require('fs');
const async = require('async');
const os = require('os');
const fetch = require('node-fetch');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(pino);

// Load Configuration
let rawconfig = fs.readFileSync('../../data/options.json');
let config = JSON.parse(rawconfig);

console.log("Starting with configuration:", config)

const localUrl = config.LOCAL_URL ? config.LOCAL_URL : os.hostname()
const port = config.PORT ? config.PORT : '8349'

const baseUrl = 'http://' + localUrl + ':' + port
const baseUrlRedirect = localUrl === "localhost" ? 'http://' + localUrl + ':' + port : 'https://' + localUrl + ':' + port

// This section services the OAuth2 flow
const oauthConfig = {
  client: {
    id: config.SONOS_CLIENT_ID,
    secret: config.SONOS_CLIENT_SECRET,
  },
  auth: {
    tokenHost: 'https://api.sonos.com',
    tokenPath: '/login/v3/oauth/access',
    authorizePath: '/login/v3/oauth',
  },
};
const client = new AuthorizationCode(oauthConfig);


// Authorization uri definition
const authorizationUri = client.authorizeURL({
  redirect_uri: baseUrlRedirect + '/redirect',
  scope: 'playback-control-all',
  state: 'none',
});

// Get our token set up

let token; // This'll hold our token, which we'll use in the Auth header on calls to the Sonos Control API
let authRequired = false; // We'll use this to keep track of when auth is needed (first run, failed refresh, etc) and return that fact to the calling app so it can redirect

// This is a function we run when we first start the app. It gets the token from the local store, or sets authRequired if it's unable to
async function getToken() {
  if (!storage.getItem) {
    // Let's initialize our local storage to keep the auth token
    // This way we don't have to log in every time the app restarts
    await storage.init({ dir: '../../data/persist/' });
  }
  const currentToken = await storage.getItem('token');
  if (currentToken === undefined) {
    authRequired = true;
    return;
  }
  try {
    token = client.createToken(currentToken.token);

    if (token.expired()) {
      try {
        token = await token.refresh();
        await storage.setItem('token', token); // And save it to local storage to capture the new access token and expiry date
      } catch (error) {
        authRequired = true;
        console.log('Error refreshing access token: ', error.message);
      }
    }
  } catch (error) {
    console.log('Access Token Error', error.message);
  }
}

async function getHouseholds(res) {
  await getToken()
  res.setHeader('Content-Type', 'application/json');
  if (authRequired) {
    res.send(JSON.stringify({ 'success': false, authRequired: true }));
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
    res.send(JSON.stringify({ 'success': false, error: err.stack }));
    return;
  }

  // We convert to text rather than JSON here, since, on some errors, the Sonos API returns plain text
  const hhResultText = await hhResult.text();

  const json = JSON.parse(hhResultText);

  return json
}

async function parseClipCapableDevices(households) {
  let allClipCapableDevices = {}
  for (let household of households) {
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
    try {
      groups = JSON.parse(groupsResultText);
      if (groups.groups === undefined) { // If there isn't a groups object, the fetch didn't work, and we'll let the caller know
        continue
      }
    }
    catch (err) {
      console.log(err)
      continue
    }

    const players = groups.players; // Let's get all the clip capable players
    const clipCapablePlayers = [];
    for (let player of players) {
      if (player.capabilities.includes('AUDIO_CLIP')) {
        clipCapablePlayers.push({ 'id': player.id, 'name': player.name });
      }
    }
    allClipCapableDevices[household.id] = clipCapablePlayers
  }
  return allClipCapableDevices
}

getToken();

// Initial page redirecting to Sonos
app.get('/auth', async (req, res) => {
  res.redirect(authorizationUri);
});

// redirect service parsing the authorization token and asking for the access token
app.get('/redirect', async (req, res) => {
  const code = req.query.code;
  const redirect_uri = baseUrlRedirect + '/redirect';

  const options = {
    code, redirect_uri,
  };

  try {
    const result = await client.getToken(options);

    token = client.createToken(result); // Save the token for use in Sonos API calls

    console.log('The resulting token: ', token);

    await storage.setItem('token', token); // And save it to local storage for use the next time we start the app
    authRequired = false; // And we're all good now. Don't need auth any more
    res.send('Auth Complete');
  } catch (error) {
    console.error('Access Token Error', error.message);
    return res.status(500).json('Authentication failed');
  }
});

// This section services the front end.

// This route handler returns the available households for the authenticated user
app.get('/api/allClipCapableDevices', async (req, res) => {
  const json = await getHouseholds(res)

  // Let's try to immediately convert that text to JSON,
  try {
    if (json && json.households !== undefined) { // if there's a households object, things went well, and we'll return that array of hhids
      const allClipCapableDevices = await parseClipCapableDevices(json.households)
      res.send(JSON.stringify({ 'success': true, 'households': allClipCapableDevices }, null, '\t'));
    }
    else {
      res.send(JSON.stringify({ 'success': false, 'error': json.error }));
    }
  }
  catch (err) {
    console.log(err)
    res.send(JSON.stringify({ 'success': false, 'error': err }));
  }

});

app.get('/api/speakText', async (req, res) => {
  await getToken()
  const text = req.query.text;
  const volume = req.query.volume;
  const playerId = req.query.playerId;
  const priority = req.query.prio;

  const speakTextRes = res;
  speakTextRes.setHeader('Content-Type', 'application/json');
  if (authRequired) {
    res.send(JSON.stringify({ 'success': false, authRequired: true }));
  }

  if (text == null || playerId == null) { // Return if either is null
    speakTextRes.send(JSON.stringify({ 'success': false, error: 'Missing Parameters' }));
    return;
  }

  let speechUrl;

  try { // Let's make a call to the google tts api and get the url for our TTS file
    speechUrl = await googleTTS(text, config.GOOGLE_TTS_LANGUAGE, 1);
  }
  catch (err) {
    speakTextRes.send(JSON.stringify({ 'success': false, error: err.stack }));
    return;
  }

  let body = { streamUrl: speechUrl, name: 'Sonos TTS', appId: 'com.me.sonosspeech' };
  if (volume != null) {
    body.volume = parseInt(volume)
  }
  if (priority && (priority.toUpperCase() === "LOW" || priority.toUpperCase() === "HIGH")) {
    body.priority = priority.toUpperCase()
  }

  let audioClipRes;

  try { // And call the audioclip API, with the playerId in the url path, and the text in the JSON body
    audioClipRes = await fetch(`https://api.ws.sonos.com/control/api/v1/players/${playerId}/audioClip`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.token.access_token}` },
    });
  }
  catch (err) {
    speakTextRes.send(JSON.stringify({ 'success': false, error: err.stack }));
    return;
  }

  const audioClipResText = await audioClipRes.text(); // Same thing as above: convert to text, since occasionally the Sonos API returns text

  try {
    const json = JSON.parse(audioClipResText);
    if (json.id !== undefined) {
      speakTextRes.send(JSON.stringify({ 'success': true }));
    }
    else {
      speakTextRes.send(JSON.stringify({ 'success': false, 'error': json.errorCode }));
    }
  }
  catch (err) {
    speakTextRes.send(JSON.stringify({ 'success': false, 'error': audioClipResText }));
  }
});

app.get('/api/playClip', async (req, res) => {
  await getToken()
  let streamUrl = req.query.streamUrl;
  const volume = req.query.volume;
  const playerId = req.query.playerId;
  const priority = req.query.prio;

  const speakTextRes = res;
  speakTextRes.setHeader('Content-Type', 'application/json');
  if (authRequired) {
    res.send(JSON.stringify({ 'success': false, authRequired: true }));
  }

  if (playerId == null) { // Return if either is null
    speakTextRes.send(JSON.stringify({ 'success': false, error: 'Missing Parameter playerId' }));
    return;
  }

  let body

  if (streamUrl) {
    if (!streamUrl.includes('http') && !streamUrl.includes('https')) {
      streamUrl = baseUrl + '/mp3/' + streamUrl // Play local file
    }
    body = { streamUrl: streamUrl, name: 'Sonos TTS', appId: 'com.me.sonosspeech' };
  }
  else {
    body = { clipType: "CHIME", name: 'Sonos TTS', appId: 'com.me.sonosspeech' }; // only supported clipType for now is CHIME
  }

  if (volume != null) {
    body.volume = parseInt(volume)
  }
  if (priority && (priority.toUpperCase() === "LOW" || priority.toUpperCase() === "HIGH")) {
    body.priority = priority.toUpperCase()
  }

  let audioClipRes;

  console.log(body)

  try { // And call the audioclip API, with the playerId in the url path, and the text in the JSON body
    audioClipRes = await fetch(`https://api.ws.sonos.com/control/api/v1/players/${playerId}/audioClip`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.token.access_token}` },
    });
  }
  catch (err) {
    speakTextRes.send(JSON.stringify({ 'success': false, error: err.stack }));
    return;
  }

  const audioClipResText = await audioClipRes.text(); // Same thing as above: convert to text, since occasionally the Sonos API returns text

  try {
    const json = JSON.parse(audioClipResText);
    if (json.id !== undefined) {
      speakTextRes.send(JSON.stringify({ 'success': true }));
    }
    else {
      speakTextRes.send(JSON.stringify({ 'success': false, 'error': json.errorCode }));
    }
  }
  catch (err) {
    speakTextRes.send(JSON.stringify({ 'success': false, 'error': audioClipResText }));
  }
});


app.get('/api/playClipAll', async (req, res) => {
  const json = await getHouseholds(res)
  let streamUrl = req.query.streamUrl;
  const volume = req.query.volume;
  const priority = req.query.prio;
  const exclude = req.query.exclude

  const speakTextRes = res;
  speakTextRes.setHeader('Content-Type', 'application/json');
  if (authRequired) {
    res.send(JSON.stringify({ 'success': false, authRequired: true }));
  }

  let body

  if (streamUrl) {
    if (!streamUrl.includes('http') && !streamUrl.includes('https')) {
      streamUrl = baseUrl + '/mp3/' + streamUrl // Play local file
    }
    body = { streamUrl: streamUrl, name: 'Sonos TTS', appId: 'com.me.sonosspeech' };
  }
  else {
    body = { clipType: "CHIME", name: 'Sonos TTS', appId: 'com.me.sonosspeech' }; // only supported clipType for now is CHIME
  }

  if (volume != null) {
    body.volume = parseInt(volume)
  }
  if (priority && (priority.toUpperCase() === "LOW" || priority.toUpperCase() === "HIGH")) {
    body.priority = priority.toUpperCase()
  }

  let requestUrls = []

  const allClipCapableDevices = await parseClipCapableDevices(json.households)

  console.log(body)

  for (let householdId in allClipCapableDevices) {
    let household = allClipCapableDevices[householdId]
    for (let player of household) {
      if (!((Array.isArray(exclude) && exclude.includes(player.name)) || exclude === player.name))
        requestUrls.push(`https://api.ws.sonos.com/control/api/v1/players/${player.id}/audioClip`)
    }
  }

  async.map(requestUrls, function (url, callback) {
    fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token.token.access_token}` },
    })
      .then(function (response) {
        response.text()
          .then(function (text) { callback(null, text); })
          .catch(function (err) { callback(err, null); });
      })
      .catch(function (reason) { callback(reason, null); });
  },
    function (err, results) {
      if (err) {
        speakTextRes.send(JSON.stringify({ 'success': false, 'error': err })); // Error in Fetch in one/more devices
      }
      else {
        // Check Sonos return value of all requests
        let success = true, error = "";

        for (let resultId in results) {
          const result = results[resultId]
          const json = JSON.parse(result);

          if (json.id === undefined) {
            success = false
            error += json.errorCode
          }
        }

        if (success) {
          speakTextRes.send(JSON.stringify({ 'success': true }));
        }
        else {
          speakTextRes.send(JSON.stringify({ 'success': false, 'error': error }));
        }
      }
    }
  );
});

app.listen(port, () =>
  console.log('Express server is running on ' + baseUrl)
);
app.use('/mp3', express.static('../../data/mp3'))