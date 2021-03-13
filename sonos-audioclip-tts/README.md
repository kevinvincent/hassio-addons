# Sonos TTS Addon

> :info: **Credit where it's due**: This is a fork of the original add-on by Kevin Vincent. I've modified it to integrate with Nabu Casa TTS through the add-on API proxy.

This project is based on original code from this [Sonos Developer Blog post](https://developer.sonos.com/code/making-sonos-talk-with-the-audioclip-api/).

This TTS method will duck the volume of whatever is currently playing on your SONOS system, play the message/audio file on top, and then bring back the volume. It sounds super nice. You can also play the TTS announcement at a different volume than the currently playing music and you also don't have to deal with snapshotting and restoring playback which has many issues especially with cloud queues on SONOS.

Some negatives:

- It isn't as well integrated into hass as the tts service (this addon requires a http call to the addon's webserver instead of an HA service call)
- It uses the cloud instead of locally connecting to your sonos speakers.
- ~~Playing announcements on speakers in sync is not yet supported. There is a workaround I’m building though.~~ Synchronised announcements work for Nabu Casa TTS with the `/api/speakHassAll` method

In a nutshell, we're using the [audioClips](https://developer.sonos.com/reference/control-api/audioclip/) namespace commands in the [Sonos Control API](https://developer.sonos.com/build/direct-control/) to play speech. This speech will be generated using Google Translate's text to speech API. You can also play arbitrary audio files hosted anywhere (including on your home assistant instance).

This will only work with the devices listed at the top of the page here: [Audio Clip Documentation](https://developer.sonos.com/reference/control-api/audioclip/)

## Home Assistant Supervised Addon Setup

### Install the Add On

Add this `https://github.com/willscottuk/hassio-addons` as a custom repository as usual and click install under this addon.

NOTE: This addon is a local build addon. That means that Home Assistant will build the addon image on your HA machine so installation might take awhile.

### Create API Key

To use this addon, you'll need to get an API key from the [Sonos Developer Portal](https://developer.sonos.com). Create an account there, then create a new [Control Integration](https://developer.sonos.com/news/create-client-credentials/). Follow instructions under "Create an integration".

_Make sure to set your redirect url to `https://hassio.local:8349/redirect` when setting up your API key, EVEN IF you access it without https or access it using the IP or other hostname. Leave the `Event Callback URL` empty!_

### Configure Options

Copy paste your Key into the SONOS_CLIENT_ID field on the addon page in Home Assistant

Copy paste your Secret into the SONOS_CLIENT_SECRET field on the addon page in Home Assistant

Hit Save and Restart the addon.

### Perform auth flow (this only has to be done once)

Visit `https://hassio.local:8349/auth` (remove https, change to ip address, etc if necessary depending on your setup)

This will redirect to Sonos and make you login with your Sonos account (make sure you use the login you use to sign in to the Sonos app on your phone, not the login you created for the developer portal above)

### (Maybe) fix redirect

If you see an Auth Complete message you can skip this step

If you got a "cannot find site" error in your browser follow this step:

Your url bar currently will look something like:
https://hassio.local:8349/redirect?state=none&code=86f62528-99f4-4162-8c01-00f2651bf234

Change the first part *https://hassio.local:8349* to match how you usually access home assistant (remove https, change to ip address, etc depending on your setup) like you did in the "Perform Auth flow" step and hit enter. You should now see the Auth Complete message.

### Go to Usage section below

## Usage

As you have noticed by now, this is very different than the built-in TTS in Home Assistant. Basically at this point, you have a webserver running at `http://hassio.local:8349` that you can make requests to.

First visit `http://hassio.local:8349/api/allClipCapableDevices`

This will list all devices in your SONOS household that the SONOS API says support playing audio clips. Copy the ID's of devices to which you may want to play TTS messages on.

NOTE: For some reason if devices are grouped together (stereo pair for example), only one will show up here though TTS works on both. This is an issue with the SONOS API but I have a workaround in mind. Its not a big deal though since the speakers will usually be in close proximity if paired that way.

You can play Google TTS announcements by visiting (from your browser or through a GET request from NODE-RED, CURL, rest_command in HA) `http://hassio.local:8349/api/speakText?playerId=<playerID>&text=<text>&volume=<0 - 100>`

You can play Nabu Casa TTS announcements by visiting (from your browser or through a GET request from NODE-RED, CURL, rest_command in HA) `http://hassio.local:8349/api/speakHass?playerId=<playerID>&text=<text>&volume=<0 - 100>`

You can play announcements on all compatible SONOS speakers at the same time by visiting (from your browser or through a GET request from NODE-RED, CURL, rest_command in HA) `http://hassio.local:8349/api/speakHassAll?text=<text>&volume=<0 - 100>`

You can play arbitrary audio files using `http://hassio.local:8349/api/playClip?playerId=<playerID>&streamUrl=<url>&volume=<0 - 100>`

I recommend starting with volumes between 20 - 30 and working your way up in increments of 5. 100 is very very loud.
