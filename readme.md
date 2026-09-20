# providence

centralized messaging platform

## run the app

Install each side once:

```bash
npm --prefix backend install
npm --prefix frontend install
```

Copy `backend/.env.example` to `backend/.env`, then configure a complete Discord and/or Instagram credential pair as described in [the backend guide](backend/README.md). Start the API and Expo app together from the repository root:

```bash
npm run dev
```

The Expo app calls `http://localhost:3001` by default (`http://10.0.2.2:3001` on the Android emulator). For a physical device, copy `frontend/.env.example` to `frontend/.env.local`, replace `localhost` with the computer's LAN IP address, and set `HOST=0.0.0.0` in `backend/.env`. Never put provider credentials in an `EXPO_PUBLIC_` variable—the frontend bundle is public.

Useful verification commands:

```bash
npm test
npm run build
```

## problem statement

suppose you usually use some social media platform. you talk to *most* of your friends here, but then you meet other people who only use other platforms. this forces you to install another app just to talk to them. wouldn't it be nice if all messages were available to you on one centralized single platform for you?

## proposed soln

have web scrapers programatically scrape your social media message feeds. users will manually connect each feed that they want to centralize (you provide your current login information or cookies). web scrapers will monitor each channel for new information and will convert it into a standardized format to be sent to the user.

when users want to perform actions like sending messages, replying to messages, adding reactions, these will also be standardized. the possible actions in the app can be described as the intersection of all possible actions on the various platforms (ie. a feature available exclusively on one platform cannot be generalized for providence, and will not be included in the standardized sent message format).

## implementation

frontend with expo, backend with express.
scraping done with playwright + custom built chromium to prevent automation detection.

## roadmap

- add muting
- add profile merging (ie. one contact is found on several providers, we will merge their messages into one giant provider, sending to either their most frequented provider OR a user configured override)
- clean up the ui


## if there's time...

- add user authentication
- add per-user data storage on an actual db rather than locally
- add ai message preprocessing routines
