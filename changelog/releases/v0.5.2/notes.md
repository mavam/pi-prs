Pull request review feedback and CI failures now wait until the agent finishes its current work. Idle agents still respond immediately.

## 🐞 Bug fixes

### Pull request feedback without mid-turn interruptions

Pull request review feedback, CI failures, and `/pr watch --babysit` instructions now wait until the agent finishes its current work instead of steering it mid-turn. When the agent is idle, they still start a turn immediately.

*By @mavam in #10.*
