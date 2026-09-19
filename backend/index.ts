import {chromium} from 'playwright'
import dotenv from 'dotenv'

dotenv.config({quiet: true})

// currently only for one user: will scale to multiple later
const CUSTOM_CHROMIUM_PATH = process.env.CUSTOM_CHROMIUM_PATH
const USER_DATA_DIR = process.env.USER_DATA_DIR!!

const config = {}

if (CUSTOM_CHROMIUM_PATH) {
    config.executablePath = CUSTOM_CHROMIUM_PATH
}

const context = await chromium.launchPersistentContext(USER_DATA_DIR, config);

