# substream for spice2x

A browser front end for [spice2x](https://github.com/spice2x/spice2x.github.io): shows the game screen
and sends mouse/touch input back to it. That's all.

## Setting up spice2x for API server

Launch the game with the API and the video stream enabled:

```
spice64.exe -api <port> -apistream
```

Add `-apipass <password>` if you want the input connection encrypted.

Alternatively, in spicecfg:

<img width="568" height="356" alt="cfg" src="https://github.com/user-attachments/assets/caeffedb-1162-4d49-a30f-16bbe0a1d6d9" />

## Streaming sub screen to substream app

Grab the latest zip from [Releases](https://github.com/spice2x/substream/releases) and unpack it anywhere.

### If you want to run it on your PC

Double click index.html to launch in a browser.

### If you want to run it on your mobile device

Double-click `serve.bat` to start the server on your PC. It doesn't have to be on the same PC that is running spice2x.

Open a web browser on any device and navigate to one of the URLs shown by the server.

To make the web page full screen on iOS, use Share then Add to Home Screen and launch it from there.

#### Using a different port

`serve.bat` listens on `45000`. Pass a port to change it:

```
serve.bat 9000
```

Port `8080` is deliberately avoided - spice2x runs its own e-amusement server there for `-ea`,
and also falls back to it when smart e-amusement finds the real service unreachable. Sharing
that port breaks whichever of the two starts second.

## Options

Fill in the host, press Connect. Settings are remembered, including the password, in plain text.

| Setting       | Notes                                             |
| ------------- | ------------------------------------------------- |
| Host          | Address of the machine running the game           |
| API port      | Whatever was passed to `-api`, default `1337`     |
| Password      | Matches `-apipass`, leave empty if unused         |
| Format        | `H.264` is far lighter on battery and bandwidth   |
| Screen        | `auto` picks the subscreen when the game has one  |
| FPS / Quality | 1-60 and 1-100, lower them on a slow connection   |

H.264 decodes in hardware and costs a few times less bandwidth than MJPEG, so it is the
better choice on a phone. It needs iOS 16.4 or a recent desktop browser; where that is
missing the option is greyed out and MJPEG is used instead. A build of spice2x without the
H.264 encoder falls back to MJPEG on its own.

## Troubleshooting

- Ensure spice2x is up to date.
- Let port, port+1, and port+2 through Windows Firewall when connecting from another device.
- Double check your IP; don't mix up IP address of PC running the game (spice2x API port) and IP address of PC running substream - which may or may not be the same.
- Web server must be running on HTTP, not HTTPS.
- spice2x limits to one viewer per screen for the stream API. Disconnect all other clients if you can connect to API but can't get video.
- Streaming video from spice2x is unencrypted and unauthenticated. Anyone who can reach the port can watch.
