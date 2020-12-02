
# Homebridge Eufy Security Plugin

This is a work in progress

Mainly a doorbell plugin for now. Will include others later.

## What works?

- Doorbell chime notifications
- Video camera with audio

## Installing

package

```bash
npm install -g homebridge-plugin-eufy-security
```

Config

```json
# Supply your email and password to the config
{
    "platforms": [
        {
            "name": "Eufy",
            "username": "your-email@gmail.com",
            "password": "your-password",
            "platform": "EufySecurityHomebridgePlugin"
        }
    ]
}
```
