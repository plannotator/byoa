# Changelog

## 0.1.1

- Uses `@plannotator/byoa-connector-core` 0.1.1. It caches each app's last `tools/list` under `~/.byoa/tools/`, so a session that starts while an app is deploying still gets that app's tool. Tool calls still go to the live app.
- Depends on `@plannotator/byoa-connector-core` and `@plannotator/byoa-protocol` with caret ranges (`^0.1.1`, `^0.1.0`), so later connector-core patches reach this package without a new release.
