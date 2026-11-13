# @dsh-mobile/bundle

One Plugins entry for the `dsh-mobile` repository (spec `specs/028-single-bundle`). It carries no code:
its `dsh.bundle.patch` lists the three plugins' own patch files, so the rows, ids, names and config
are exactly what each plugin declares.

| Row id | Package | What it is |
|---|---|---|
| `devices` | `@dsh-ext/devices` | Devices page: pair and control other DSH Hosts; the pairing-code dialog |
| `mobile-gateway` | `@dsh-ext/mobile-gateway` | The phone gateway (pinned TLS, loopback by default) |
| `sidebar-browser` | `@dsh-ext/sidebar-browser` | Agent tools for the sidebar Browser tab |

Each row keeps its own switch on the bundle's page; the gateway can be turned off alone.

## How it loads (read from DSH 0.2.2-rc.3 source)

- `dsh-app-boot/src/profile.ts` `bundlePatchPaths` joins every `dsh.bundle.patch` entry with the
  bundle directory, so `../plugins/<name>/cordis.patch.yml` is that plugin's own file.
- Row names are bare package names. The Loader resolves them from the profile root, so the profile
  keeps the three plugins as plain `link:` dependencies. They no longer declare `dsh.bundle`, so the
  Plugins page does not list them as bundles (`dsh-plugin-manager` lists a dependency without a patch
  only while it is selected).
- Stored config is keyed by row id in the profile patch, never by bundle, so the existing
  `mobile-gateway` / `sidebar-browser` overrides keep applying.

## Updates

Plugins offers no native **Update** for a `link:` bundle. The Devices row adds the spec-027 updater
("Check for updates" / "Update") as a section on this bundle's page through the public
`plugins.detail.section` slot; it updates the linked checkout to its latest release tag.

This is a local link bundle. It is not a publishable tarball.
