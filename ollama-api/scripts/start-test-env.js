'use strict';
/** Поднимает API с переменными из ollama-api/.env.test (абсолютный путь в DOTENV_CONFIG_PATH). */
const path = require('path');
process.env.DOTENV_CONFIG_PATH = path.join(__dirname, '..', '.env.test');
require('../index.js');
