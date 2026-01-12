module.exports = {
  apps : [{
    name   : "scrcpy-web",
    script : "./server.js",
    watch: false,
    env: {
      NODE_ENV: "production",
    }
  }]
}
