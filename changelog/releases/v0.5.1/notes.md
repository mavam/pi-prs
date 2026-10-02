This release shortens the instructions that `/pr watch --babysit` gives to the agent. The agent follows the same assess, fix, reply, and resolve flow with less repetition.

## 🐞 Bug fixes

### Concise babysitting prompt

The `/pr watch --babysit` instructions are now shorter and no longer repeat themselves, so the agent gets a clearer, more focused prompt. Behavior is unchanged: the agent still verifies each finding, fixes valid ones, replies on GitHub with the commit SHA or an evidence-based rejection reason, and resolves the review thread. Blocked work stays unresolved.

*By @mavam in #9.*
