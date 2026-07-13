// PM2 process config — keeps the server running and restarts on reboot.
// Usage:  pm2 start ecosystem.config.cjs   &&   pm2 save
module.exports = {
  apps: [
    {
      name: 'screening-room',
      script: 'server/index.js',
      env: {
        PORT: 3000,
        // ⚠️ 切勿在此处硬编码密码！
        // 请通过系统环境变量或 PM2 的 --env 参数注入 SCREENING_PASSWORD
        // 示例: SCREENING_PASSWORD=your-secret pm2 start ecosystem.config.cjs
      },
    },
  ],
};
