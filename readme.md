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

## roadmap

- add muting, notifications, 
- add profile merging (ie. one contact is found on several providers, we will merge their messages into one giant provider, sending to either their most frequented provider OR a user configured override)
- clean up the ui


## if there's time...

- add user authentication
- add per-user data storage on an actual db rather than locally
- add ai message preprocessing routines
