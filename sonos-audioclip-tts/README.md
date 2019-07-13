# Sonos TTS Addon

This project is based on original code from this [Sonos Developer Blog post]( https://developer.sonos.com/code/making-sonos-talk-with-the-audioclip-api/).

In a nutshell, we're using the [audioClips](https://developer.sonos.com/reference/control-api/audioclip/) namespace commands in the [Sonos Control API](https://developer.sonos.com/build/direct-control/) to play speech. This speech was created using Google Translate's text to speech API.

This will only work with the devices listed at the top of the page here: [Audio Clip Documentation](https://developer.sonos.com/reference/control-api/audioclip/)

## Addon Setup

### Install the Add On
Add this `https://github.com/kevinvincent/hassio-addons` as a custom repository as usual and click install under this addon.

NOTE: This addon is a local build addon. That means that Home Assistant will build the addon image on your HA machine so installation might take awhile.

### Create API Key
To use this addon, you'll need to get an API key from the [Sonos Developer Portal](https://developer.sonos.com). Create an account there, then create a new [Control Integration](https://developer.sonos.com/news/create-client-credentials/).

*Make sure to set your redirect url to `https://hassio.local:8349/redirect` when setting up our API key, EVEN IF you access it without https or access it using the IP or other hostname.*

### Configure Options
Copy paste your Key into the SONOS_CLIENT_ID field
Copy paste your Secret into the SONOS_CLIENT_SECRET field.
Hit Save and Restart the addon.

### Perform auth flow (this only has to be done once)
Visit `https://hassio.local:8349/auth` (remove https, change to ip address, etc if necessary depending on your setup)

This will redirect to Sonos and make you login with your Sonos account (make sure you use the login you use to sign in to the Sonos app on your phone, not the login you created for the developer portal above)

### (Maybe) fix redirect
If you see an Auth Complete message you can skip this step

If you got a cannot find server error in your browser follow this step:
Your url bar will look something like:
https://hassio.local:8349/redirect?state=none&code=86f62528-99f4-4162-8c01-00f2651bf234

Change the first part *https://hassio.local:8349* to match how you usually access home assistant (remove https, change to ip address, etc depending on your setup) and hit enter. You should now see the Auth Complete message

## Usage

As you have noticed by now. This is very different than the built-in TTS in Home Assistant. Basically at this point, you have a webserver running at `http://hassio.local:8349` that you can make requests to.

First visit `http://hassio.local:8349/api/allClipCapableDevices`

This will list all devices that Sonos says supports playing audio clips. Copy the ID's of devices to which you may want to play TTS messages on.

NOTE: For some reason if devices are grouped together (stereo pair for example), only one will show up here though TTS works on both. This is an issue with the API.

You can play Google TTS announcements by visiting (from your browser or through a GET request from NODE-RED, CURL in HA) `http://hassio.local:8349/api/speakText?playerId=<playerID>&text=<text>&volume=<0 - 100>`

You can play arbitrary audio files using `http://hassio.local:8349/api/playClip?playerId=<playerID>&streamUrl=<url>&volume=<0 - 100>`

I recommend starting with volumes between 20 - 30 and working your way up. 100 is very very loud.






