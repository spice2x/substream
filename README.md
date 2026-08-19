# substream for spice2x

A browser front end for [spice2x](https://github.com/spice2x/spice2x.github.io): shows the game screen
and sends mouse/touch input back to it. That's all.

## Setting up spice2x for API server

Grab the latest zip from [Releases](https://github.com/spice2x/substream/releases) and unpack it
anywhere.

Launch the game with the API and the video stream enabled:

```
spice64.exe -api <port> -apistream
```

Add `-apipass <password>` if you want the input connection encrypted.

## Running the substream server

Double-click `serve.bat` to start the server. It doesn't have to be on the same PC that is running spice2x.

## Connecting a client

Open a web browser on any device and navigate to one of the URLs shown by the server.

To make the web page full screen on iOS, use Share then Add to Home Screen and launch it from there.

## Options

Fill in the host, press Connect. Settings are remembered, including the password, in plain text.

| Setting       | Notes                                             |
| ------------- | ------------------------------------------------- |
| Host          | Address of the machine running the game           |
| API port      | Whatever was passed to `-api`, default `1337`     |
| Password      | Matches `-apipass`, leave empty if unused         |
| Screen        | `auto` picks the subscreen when the game has one  |
| FPS / Quality | 1-60 and 1-100, lower them on a slow connection   |

## Troubleshooting

- Ensure spice2x is up to date.
- Let port, port+1, and port+2 through Windows Firewall when connecting from another device.
- Web server must be running on HTTP, not HTTPS.
- spice2x limits to one viewer per screen for the stream API.
- Streaming video from spice2x is unencrypted and unauthenticated. Anyone who can reach the port can watch.
