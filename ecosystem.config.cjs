module.exports = {
  apps: [
    {
      name: 'veeam-telegram-monitor',
      cwd: __dirname,
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
