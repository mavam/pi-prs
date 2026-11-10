Babysitting now requests focused regression tests only when they fill a meaningful coverage gap, reducing unnecessary test writing while preserving relevant checks.

## 🔧 Changes

### More selective regression testing during babysitting

The `/pr watch --babysit` prompt now asks for a focused regression test only when it fills a meaningful coverage gap, rather than requiring regression coverage for every valid finding. This reduces unnecessary test writing while keeping relevant checks in place.

*By @mavam in #14.*
