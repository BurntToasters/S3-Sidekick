# Release verification without CI status

Failure modes recorded before implementation:

- Prepare or a platform continuation still queries GitHub Actions and refuses
  an otherwise valid release with no completed CI run.
- Standalone publishing or mirroring retains an indirect CI-status dependency.
- Removing the remote requirement accidentally removes local `test:all`,
  release-session verification, or uploaded artifact/signature verification.
- Documentation or package commands still instruct hosts to run the removed check.

Proof: release-pipeline script regression tests inspect every release entry point
and preserve the existing executable session and artifact safety tests. Run
`node --test scripts/release-pipeline.test.js`; save TAP output under
`test-results/release-ci-independence.tap`. Full gate: `npm run test:all`.
