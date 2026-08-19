# spiceweb

A browser front end for [spice2x](https://github.com/spice2x/spice2x): shows the game screen
and sends mouse/touch input back to it. Nothing else.

## Setup

Grab the latest zip from [Releases](https://github.com/spice2x/substream/releases) and unpack it
anywhere.

Launch the game with the API and the video stream enabled:

```
spice64.exe -api 1337 -apistream
```

Add `-apipass <password>` if you want the input connection encrypted.

## Running

Double-click `serve.bat`, then open the URL it prints. To use it from a phone or tablet,
pick the one with the PC's network address.

On iPhone and iPad, use Share then Add to Home Screen and launch it from there - iOS has no
fullscreen button to offer, but a home screen app runs without browser chrome.

Opening `index.html` directly also works if the browser is on the same PC as the game.

## Usage

Fill in the host, press Connect, and touch the screen. Settings are remembered.

| Setting       | Notes                                             |
| ------------- | ------------------------------------------------- |
| Host          | Address of the machine running the game           |
| API port      | Whatever was passed to `-api`, default `1337`     |
| Password      | Matches `-apipass`, leave empty if unused         |
| Screen        | `auto` picks the subscreen when the game has one  |
| FPS / Quality | 1-60 and 1-100, lower them on a slow connection   |

## If it does not work

- Let ports `1338` and `1339` through Windows Firewall when connecting from another device.
- Serve the page over plain HTTP. An HTTPS page cannot reach the game at all.
- Only one viewer per screen is allowed. Close the other tab and it will connect on its own.
- The video is unencrypted and unauthenticated. Anyone who can reach the port can watch.
