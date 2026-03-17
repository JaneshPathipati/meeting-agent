// file: client-agent/src/renderer/setup.js
window.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const steps = [
    document.getElementById('step-1'),
    document.getElementById('step-2'),
    document.getElementById('step-3'),
    document.getElementById('step-4'),
    document.getElementById('step-5'),
  ];
  const successPanel = document.getElementById('step-success');
  const dots = [
    document.getElementById('dot-1'),
    document.getElementById('dot-2'),
    document.getElementById('dot-3'),
    document.getElementById('dot-4'),
    document.getElementById('dot-5'),
  ];
  const lines = [
    document.getElementById('line-1'),
    document.getElementById('line-2'),
    document.getElementById('line-3'),
    document.getElementById('line-4'),
  ];

  // Step 1 elements
  const authKeyInput = document.getElementById('authKeyInput');
  const verifyKeyBtn = document.getElementById('verifyKeyBtn');
  const step1Org = document.getElementById('step1-org');
  const step1Error = document.getElementById('step1-error');

  // Step 2 elements
  const emailInput = document.getElementById('emailInput');
  const verifyEmailBtn = document.getElementById('verifyEmailBtn');
  const step2Org = document.getElementById('step2-org');
  const step2Email = document.getElementById('step2-email');
  const step2Error = document.getElementById('step2-error');

  // Step 3 (Microsoft sign-in) elements
  const msSignInBtn = document.getElementById('msSignInBtn');
  const skipMsSignInBtn = document.getElementById('skipMsSignInBtn');
  const step3MsStatus = document.getElementById('step3-ms-status');
  const step3MsError = document.getElementById('step3-ms-error');

  // Step 4 (profile) elements
  const step4Org = document.getElementById('step4-org');
  const firstNameInput = document.getElementById('firstName');
  const lastNameInput = document.getElementById('lastName');
  const customRoleGroup = document.getElementById('customRoleGroup');
  const customRoleInput = document.getElementById('customRole');
  const continueToConsentBtn = document.getElementById('continueToConsentBtn');
  const step4Error = document.getElementById('step4-error');

  // Step 5 (consent) elements
  const step5Org = document.getElementById('step5-org');
  const consentCheckbox = document.getElementById('consentCheckbox');
  const completeBtn = document.getElementById('completeBtn');
  const step5Error = document.getElementById('step5-error');

  // State
  let currentStep = 0;
  let orgId = null;
  let orgName = null;
  let msEmail = null;

  // Check if already authenticated
  try {
    const status = await window.meetChamp.getAuthStatus();
    if (status.authenticated && status.enrolled) {
      showStep(-1);
      return;
    }
  } catch (err) {
    // Continue with setup
  }

  function showStep(idx) {
    steps.forEach((s, i) => {
      s.style.display = i === idx ? 'block' : 'none';
    });
    successPanel.style.display = idx === -1 ? 'block' : 'none';

    dots.forEach((d, i) => {
      d.classList.remove('active', 'completed');
      if (i < idx || idx === -1) d.classList.add('completed');
      else if (i === idx) d.classList.add('active');
    });
    lines.forEach((l, i) => {
      l.classList.remove('completed');
      if (i < idx || idx === -1) l.classList.add('completed');
    });

    currentStep = idx;
  }

  // Auto-format auth key input
  authKeyInput.addEventListener('input', () => {
    const cursorPos = authKeyInput.selectionStart;
    const raw = authKeyInput.value;
    const clean = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
    const formatted = clean.replace(/(.{4})(?=.)/g, '$1-');
    if (authKeyInput.value !== formatted) {
      authKeyInput.value = formatted;
      const addedHyphens = (formatted.slice(0, cursorPos + 1).match(/-/g) || []).length -
                           (raw.slice(0, cursorPos).match(/-/g) || []).length;
      authKeyInput.setSelectionRange(cursorPos + addedHyphens, cursorPos + addedHyphens);
    }
  });

  // Step 1: Verify Authorization Key
  verifyKeyBtn.addEventListener('click', async () => {
    const key = authKeyInput.value.trim();
    step1Error.textContent = '';
    step1Org.style.display = 'none';

    if (!key) { step1Error.textContent = 'Please enter an authorization key.'; return; }

    verifyKeyBtn.disabled = true;
    verifyKeyBtn.textContent = 'Verifying...';

    try {
      const result = await window.meetChamp.verifyAuthKey(key);
      if (result.success) {
        orgId = result.orgId;
        orgName = result.orgName;
        step1Org.textContent = 'Organization: ' + orgName;
        step1Org.style.display = 'block';
        setTimeout(() => {
          step2Org.textContent = 'Organization: ' + orgName;
          showStep(1);
        }, 800);
      } else {
        step1Error.textContent = result.error || 'Invalid authorization key.';
      }
    } catch (err) {
      step1Error.textContent = 'Verification failed: ' + (err.message || err);
    }

    verifyKeyBtn.disabled = false;
    verifyKeyBtn.textContent = 'Verify & Continue';
  });

  authKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyKeyBtn.click(); });

  // Step 2: Email Verification
  async function doVerifyEmail() {
    step2Error.textContent = '';
    const email = emailInput.value.trim().toLowerCase();

    if (!email || !email.includes('@')) {
      step2Error.textContent = 'Please enter a valid email address.';
      return;
    }

    verifyEmailBtn.disabled = true;
    verifyEmailBtn.textContent = 'Verifying...';

    try {
      const result = await window.meetChamp.verifyEmail(email);
      if (result.success) {
        msEmail = email;
        step2Email.textContent = 'Verified: ' + email;
        step2Email.style.display = 'block';

        if (result.alreadyEnrolled) {
          // Returning user: check if they need Microsoft sign-in for Teams features
          if (result.needsMicrosoftSignIn) {
            document.getElementById('step3-org-ms');
            setTimeout(() => {
              const orgBadge = document.getElementById('step3-org-ms');
              if (orgBadge) orgBadge.textContent = 'Welcome back, ' + (result.fullName || email) + '!';
              // Show Microsoft sign-in step — they can skip if not using Teams
              showStep(2);
            }, 800);
            // Override the skip button to go to success instead of profile form
            skipMsSignInBtn.onclick = () => {
              document.getElementById('success-title').textContent = 'Welcome Back!';
              document.getElementById('success-desc').textContent = 'MeetChamp is now running.';
              document.getElementById('success-subdesc').textContent = 'The agent will automatically detect and transcribe your meetings.';
              showStep(-1);
              setTimeout(() => window.meetChamp.closeSetup(), 3000);
            };
            // Override Microsoft sign-in success to go to success
            const origMsHandler = msSignInBtn.onclick;
            msSignInBtn.onclick = async () => {
              step3MsError.textContent = '';
              msSignInBtn.disabled = true;
              msSignInBtn.textContent = 'Opening browser...';
              try {
                const msResult = await window.meetChamp.microsoftSignIn();
                if (msResult.success) {
                  step3MsStatus.textContent = 'Signed in as: ' + (msResult.account?.username || 'Microsoft Account');
                  step3MsStatus.style.display = 'block';
                  step3MsStatus.style.color = '#16a34a';
                  msSignInBtn.textContent = 'Signed In ✓';
                  setTimeout(() => {
                    document.getElementById('success-title').textContent = 'Welcome Back!';
                    document.getElementById('success-desc').textContent = 'Teams features activated! MeetChamp is now running.';
                    document.getElementById('success-subdesc').textContent = 'Teams meetings will now have accurate speaker names in transcripts.';
                    showStep(-1);
                    setTimeout(() => window.meetChamp.closeSetup(), 3000);
                  }, 1000);
                } else {
                  step3MsError.textContent = msResult.error || 'Sign-in failed. You can skip this step.';
                  msSignInBtn.disabled = false;
                  msSignInBtn.textContent = 'Try Again';
                }
              } catch (err) {
                step3MsError.textContent = 'Error: ' + (err.message || err);
                msSignInBtn.disabled = false;
                msSignInBtn.textContent = 'Try Again';
              }
            };
            return;
          }

          document.getElementById('success-title').textContent = 'Welcome Back!';
          document.getElementById('success-desc').textContent = 'Welcome back, ' + (result.fullName || email) + '! MeetChamp is now running.';
          document.getElementById('success-subdesc').textContent = 'The agent will automatically detect and transcribe your meetings.';
          setTimeout(() => {
            showStep(-1);
            setTimeout(() => window.meetChamp.closeSetup(), 3000);
          }, 800);
          return;
        }

        // First-time user: advance to Microsoft sign-in step
        setTimeout(() => {
          const orgBadge = document.getElementById('step3-org-ms');
          if (orgBadge) orgBadge.textContent = 'Organization: ' + orgName;
          showStep(2);
        }, 800);
      } else {
        step2Error.textContent = result.error || 'Email not found. Contact your admin.';
        verifyEmailBtn.disabled = false;
        verifyEmailBtn.textContent = 'Verify & Continue';
      }
    } catch (err) {
      step2Error.textContent = 'An unexpected error occurred: ' + (err.message || err);
      verifyEmailBtn.disabled = false;
      verifyEmailBtn.textContent = 'Verify & Continue';
    }
  }

  verifyEmailBtn.addEventListener('click', doVerifyEmail);
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerifyEmail(); });

  // Step 3: Microsoft Sign-In
  function advanceToProfileStep() {
    step4Org.textContent = 'Organization: ' + orgName;
    showStep(3);
  }

  msSignInBtn.addEventListener('click', async () => {
    step3MsError.textContent = '';
    msSignInBtn.disabled = true;
    msSignInBtn.textContent = 'Opening browser...';

    try {
      const result = await window.meetChamp.microsoftSignIn();
      if (result.success) {
        step3MsStatus.textContent = 'Signed in as: ' + (result.account?.username || 'Microsoft Account');
        step3MsStatus.style.display = 'block';
        step3MsStatus.style.color = '#16a34a';
        msSignInBtn.textContent = 'Signed In ✓';
        setTimeout(advanceToProfileStep, 1000);
      } else {
        step3MsError.textContent = result.error || 'Microsoft sign-in failed. You can skip this step.';
        msSignInBtn.disabled = false;
        msSignInBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 21 21" style="vertical-align:middle;margin-right:6px;"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg> Try Again';
      }
    } catch (err) {
      step3MsError.textContent = 'Sign-in error: ' + (err.message || err);
      msSignInBtn.disabled = false;
      msSignInBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 21 21" style="vertical-align:middle;margin-right:6px;"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg> Try Again';
    }
  });

  skipMsSignInBtn.addEventListener('click', () => {
    advanceToProfileStep();
  });

  // Step 4: Role radio toggle for custom role
  document.querySelectorAll('input[name="role"]').forEach(radio => {
    radio.addEventListener('change', () => {
      customRoleGroup.style.display = radio.value === 'Other' ? 'block' : 'none';
    });
  });

  // Step 4: Continue to Consent
  let profileFormData = null;
  continueToConsentBtn.addEventListener('click', () => {
    step4Error.textContent = '';

    const firstName = firstNameInput.value.trim();
    const lastName = lastNameInput.value.trim();
    const roleRadio = document.querySelector('input[name="role"]:checked');
    const role = roleRadio ? roleRadio.value : null;
    const customRole = customRoleInput.value.trim();

    if (!firstName) { step4Error.textContent = 'First name is required.'; return; }
    if (!lastName) { step4Error.textContent = 'Last name is required.'; return; }
    if (!role) { step4Error.textContent = 'Please select a role.'; return; }
    if (role === 'Other' && !customRole) { step4Error.textContent = 'Please enter your custom role.'; return; }

    profileFormData = { firstName, lastName, role, customRole: role === 'Other' ? customRole : null };
    step5Org.textContent = 'Organization: ' + orgName;
    showStep(4);
  });

  // Step 5: Consent checkbox enables Complete button
  consentCheckbox.addEventListener('change', () => {
    completeBtn.disabled = !consentCheckbox.checked;
  });

  // Step 5: Complete Setup
  completeBtn.addEventListener('click', async () => {
    step5Error.textContent = '';

    if (!consentCheckbox.checked) {
      step5Error.textContent = 'You must give consent to proceed.';
      return;
    }

    completeBtn.disabled = true;
    completeBtn.textContent = 'Setting up...';

    try {
      const result = await window.meetChamp.completeEnrollment({
        orgId,
        msEmail,
        firstName: profileFormData.firstName,
        lastName: profileFormData.lastName,
        role: profileFormData.role,
        customRole: profileFormData.customRole,
        consentGiven: true,
      });

      if (result.success) {
        showStep(-1);
        setTimeout(() => window.meetChamp.closeSetup(), 3000);
      } else {
        step5Error.textContent = result.error || 'Enrollment failed. Please contact your admin.';
        completeBtn.disabled = false;
        completeBtn.textContent = 'Complete Setup';
      }
    } catch (err) {
      step5Error.textContent = 'Setup failed: ' + (err.message || err);
      completeBtn.disabled = false;
      completeBtn.textContent = 'Complete Setup';
    }
  });

  showStep(0);
});
