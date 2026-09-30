This release makes the footer's failure signal less redundant. The pull request icon is now the only icon that turns red when checks fail, and the failed-checks icon follows the footer's default color.

## 🐞 Bug fixes

### Stop coloring the CI failures icon red

The failed-checks icon in the footer no longer turns red. Only the pull request icon signals a failure with color, so the ✕ and its count follow the footer's default icon color, which you can still change in `/fancy-footer`.

*By @mavam.*
