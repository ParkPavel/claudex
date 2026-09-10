# Contributing

Start with a concrete failure, desired behavior and boundary. Changes to orchestration need
a deterministic regression case or a documented reason that a live evaluation is required.
Keep source-derived claims separate from architectural judgment.

1. Create a feature branch and a focused change.
2. Update affected contracts and documentation in the same change.
3. Run `npm run verify`; use local fixtures rather than paid model calls in the default suite.
4. For a new skill, test positive and negative triggers and compare against the no-skill
   baseline. Keep its body small; do not add another mandatory scheduler.
5. For a provider change, record official documentation and actual CLI version/behavior.
6. Open a pull request describing the problem, resulting behavior, checks and remaining limits.

Do not submit local configuration, credentials, personal paths, transcripts or vault data.
Do not introduce automatic installers or publisher credentials into ordinary test workflows.
See [security](SECURITY.md) and the [evidence register](docs/research/evidence-register.md).
