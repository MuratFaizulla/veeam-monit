# Contributing

Thanks for wanting to make the bot better. Bug reports, ideas and pull requests are all welcome.

## Reporting a problem or an idea

- **A bug**: [open an issue](https://github.com/MuratFaizulla/veeam-monit/issues/new/choose) with the bug report form. It asks for the versions of the bot, Veeam and its REST API, which are usually the answer. [Troubleshooting](docs/troubleshooting.md) may already have it.
- **An idea**: the feature request form. Describe the situation it comes from (what went unnoticed, what you had to look up in the console) rather than only the message you would like.
- **A vulnerability**: never in an issue. [SECURITY.md](SECURITY.md) says how to report it privately.

Issues are public. Replace the names and addresses of your installation with invented ones before you paste a log or a screenshot.

## Making a change

```bash
git clone https://github.com/MuratFaizulla/veeam-monit.git
cd veeam-monit
npm ci
npm run lint        # TypeScript type check
npm test            # builds, then runs every test against the compiled code
npm run start:dev   # the bot with your .env, restarting on every change
```

Node.js 22, as in the image. The tests need no Veeam and no Telegram: `test/world.cjs` puts the real services together around a fake Veeam and a fake Bot API, so a test sends what Veeam would say and reads what the bot would post.

**Before you write code:**

- [docs/architecture.md](docs/architecture.md) shows the layers. An import goes only down, and `test/architecture.test.cjs` fails otherwise.
- [CONTEXT.md](CONTEXT.md) holds the domain words the code uses (Run, Attempt, Evidence, Standing…). Use them, and add a word there when you introduce one.
- [docs/adr/](docs/adr/) records decisions that look like mistakes until you know why they were made.

**In the code:**

- Write like the code around it: the same naming, the same idioms, comments as dense as its neighbours'. A comment says why, not what.
- Every read of Veeam is a `GET`. The bot never changes anything in Veeam, and a change that would needs an issue first.
- The bot's messages are in Russian, and the tests assert their text. A change to a message changes its test with it.

**Tests:** every change of behaviour comes with a test that fails without it. Tests are plain `node:test` files in `test/`, written against `dist/`.

**Names and addresses:** code, tests, docs, commit messages and issues use only invented names and the documentation ranges: hosts under `example.com` or `example.net`, addresses from `192.0.2.0/24`, `198.51.100.0/24` and `203.0.113.0/24`, jobs like `OPS_Exchange` or `CUST_FINHUB`. Never those of a real installation, yours included: the repository is public, and so is its history.

## Pull requests

- One subject per pull request. A refactoring and a fix are two.
- Add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice, and update the docs that describe it.
- Commit messages say what the change does for the person using the bot, in the imperative: "Wait after Veeam refuses the password instead of asking every minute".
- CI runs the type check, the tests and the Docker image on every pull request. A pull request is merged when it is green.

## Releasing

For the maintainer: a version is released by pushing a tag `vX.Y.Z`, and [docs/architecture.md](docs/architecture.md#development) has the steps.

## Licence

The project is licensed under the [Apache License 2.0](LICENSE). By sending a contribution you agree that it is licensed under the same terms, as section 5 of the licence says.
