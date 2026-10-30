const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

fs.mkdirSync('output', { recursive: true });

module.exports = {
  chromium,
  launchOptions: {
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {})
  }
};
