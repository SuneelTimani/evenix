const passport = require("passport");
const router = require("express").Router();
const { setAuthCookies } = require("../utils/authTokens");

router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["openid", "profile", "email"],
    accessType: "offline",
    prompt: "consent",
    session: false
  })
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/login.html",
    session: false
  }),
  (req, res) => {
    if (req.user?.isAccountLocked) {
      return res.redirect("/login.html?error=account_locked");
    }
    const { accessToken } = setAuthCookies(res, req.user);
    const target = "/";

    res.send(`
      <!DOCTYPE html>
      <html>
      <body>
        <script>
          localStorage.setItem("token", ${JSON.stringify(accessToken)});
          window.location.href = ${JSON.stringify(target)};
        </script>
      </body>
      </html>
    `);
  }
);

module.exports = router;
