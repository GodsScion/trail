---
name: apply-greenhouse
match: "boards.greenhouse.io/*/jobs/*"
requires: [profile, resume]
confirm_submit: true
rate_limit: 10/hour
---

## Intent
Apply to a Greenhouse job posting. Never submit without confirmation.

## Steps
1. Click Apply
   <!-- hint: role=link[name="Apply for this job"] -->
2. Upload resume from $RESUME
   <!-- hint: role=button[name="Attach"] -->
3. Fill name/email/phone from $PROFILE
   <!-- hint: role=textbox[name="First Name"] -->
4. Custom questions -> reason from $PROFILE
5. Screenshot, stop for confirmation
