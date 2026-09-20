# providence

centralized messaging platform

## problem statement

suppose you usually use some social media platform. you talk to *most* of your friends here, but then you meet other people who only use other platforms. this forces you to install another app just to talk to them. wouldn't it be nice if all messages were available to you on one centralized single platform for you?

## proposed soln

have web scrapers programatically scrape your social media message feeds. users will manually connect each feed that they want to centralize (you provide your current login information or cookies). web scrapers will monitor each channel for new information and will convert it into a standardized format to be sent to the user.

when users want to perform actions like sending messages, replying to messages, adding reactions, these will also be standardized. the possible actions in the app can be described as the intersection of all possible actions on the various platforms (ie. a feature available exclusively on one platform cannot be generalized for providence, and will not be included in the standardized sent message format).

## implementation

frontend with expo, backend with express.
scraping done with playwright + custom built chromium to prevent automation detection.

## Run the integrated app

Start the backend first:

```bash
cd backend
npm install
# Create .env with DISCORD_EMAIL and DISCORD_PASSWORD.
# USER_DATA_DIR defaults to backend/user-data.
npm run dev
```

Then start Expo in a second terminal:

```bash
cd frontend
npm install
npm start
```

The frontend uses `http://localhost:3001` on web and the iOS simulator, and
`http://10.0.2.2:3001` on the Android emulator. For a physical device, expose
the backend on your LAN and give Expo the machine's reachable address:

```bash
# backend/.env
HOST=0.0.0.0

# frontend shell
EXPO_PUBLIC_API_URL=http://192.168.1.10:3001 npm start
```

Use your machine's actual LAN IP in place of `192.168.1.10`. The Connections
tab shows the address currently used by the frontend and the Discord provider
state.
