// PM2 process config — keeps the server running and restarts on reboot.
// Usage:  pm2 start ecosystem.config.cjs   &&   pm2 save
module.exports = {
  apps: [
    {
      name: 'screening-room',
      script: 'server/index.js',
      env: {
        PORT: 3000,
        // Change this password before sharing the link!
        SCREENING_PASSWORD: 'love',
      },
    },
  ],
};
