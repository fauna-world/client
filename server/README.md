# Fauna server

## Prerequisites

* `node` version 12 or greater
* `redis` server

## Installation

Simply run `npm install` in this directory

## Running

> `npm start`

The environment variable `FAUNA_ENV` dictates the postfix used for all keys in redis: e.g. when set to `prod` (the default), redis keys will be prefixed by `fauna-prod`. This can be set in the `start` CLI invocation like so:

> `FAUNA_ENV='dev' npm start`

## Configuration

### HTTP & WebSocket servers

`http.`

| Name | Description |
| --- | --- |
| `port` | The main HTTP server port. |
| `wsPort` | The WebSocket server port. |
| `wsPingFreq` | How often (in seconds) to send [`ping`s](https://tools.ietf.org/html/rfc6455#section-5.5.2) to connected clients. |
| `bind` | The host address to bind the server(s) to: use `0.0.0.0` to allow external connections. |
| `log` | The file into which combined logging output will be written. |
| `clientSite` | (optional) When set to a valid filesystem path, uses that path as the root content directory for static file hosting. Set to `../client` to serve the included client via this static hosting mode. |

### Redis

`redis.`

| Name | Description |
| --- | --- |
| `url` | A Redis connection string URL as accepted by the [`ioredis`](https://github.com/luin/ioredis) [constructor](https://ioredis.readthedocs.io/en/latest/API/#redis-eventemitter). May be set in the form `env:X`, where `X` is an environment variable name in which the required URL is available. |

### Application

`app.`

| Name | Description |
| --- | --- |
| `menuAutohideDelay` | Sets the number of seconds before the console menu autohides. **Leave this `null`**, the feature is currently broken and I haven't bothered to fix it yet. |
| `cookieName` | The name of the cookie used to save the player's avatar ID in the browser. |
| `logChatToConsole` | If chat messages should be logged to the server console (may be changed in the UI as well). |
| `sendTimeUpdatesEvery` | How often, in seconds, to emit gametime update messages to each connected client. |
| `motdFile` | The HTML file to send to each newly-connected websocket client as the "message of the day". |

#### Input sanitization

`app.sanitize.`

| Name | Description |
| --- | --- |
| `lengthLimit` | The maximum length of any user input string. |
| `avatarNameLengthLimit` | The maximum length of an avatar's name. |

### Engine

`engine.`

| Name | Description |
| --- | --- |
| `tickFreqHz` | The frequency, in hertz, at which the main loop runs. |
| `timeMult` | How much more quickly game time elapses than real time, as a multiplier. |

### Game

*TBD*
