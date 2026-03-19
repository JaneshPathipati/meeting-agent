// file: scriptor/src/renderer/setup.js
// Scriptor setup wizard — 4-step enrollment flow
// Step 1: Organization key
// Step 2: Email verification
// Step 3: Microsoft sign-in (optional) + profile form
// Step 4: Consent + activate
'use strict';

window.addEventListener('DOMContentLoaded', async () => {
  // Step panels
  const panels = [
    document.getElementById('step-1'),
    document.getElementById('step-2'),
    document.getElementById('step-3'),
    document.getElementById('step-4'),
  ];
  const successPanel = document.getElementById('step-success');
  const segments = [
    document.getElementById('seg-1'),
    document.getElementById('seg-2'),
    document.getElementById('seg-3'),
    document.getElementById('seg-4'),
  ];

  // Step 1
  const authKeyInput = document.getElementById('authKeyInput');
  const verifyKeyBtn = document.getElementById('verifyKeyBtn');
  const step1Org = document.getElementById('step1-org');
  const step1Error = document.getElementById('step1-error');

  // Step 2
  const emailInput = document.getElementById('emailInput');
  const verifyEmailBtn = document.getElementById('verifyEmailBtn');
  const step2Org = document.getElementById('step2-org');
  const step2Email = document.getElementById('step2-email');
  const step2Error = document.getElementById('step2-error');

  // Step 3 — MS sign-in + profile
  const msSignInBtn = document.getElementById('msSignInBtn');
  const skipMsSignInBtn = document.getElementById('skipMsSignInBtn');
  const step3MsStatus = document.getElementById('step3-ms-status');
  const step3MsError = document.getElementById('step3-ms-error');
  const profileSection = document.getElementById('profileSection');
  const firstNameInput = document.getElementById('firstName');
  const lastNameInput = document.getElementById('lastName');
  const customRoleGroup = document.getElementById('customRoleGroup');
  const customRoleInput = document.getElementById('customRole');
  const continueToConsentBtn = document.getElementById('continueToConsentBtn');
  const step3ProfileError = document.getElementById('step3-profile-error');

  // Step 4 — consent
  const step4Org = document.getElementById('step4-org');
  const consentCheckbox = document.getElementById('consentCheckbox');
  const completeBtn = document.getElementById('completeBtn');
  const step4Error = document.getElementById('step4-error');

  // State
  let currentStep = 0;
  let orgId = null;
  let orgName = null;
  let msEmail = null;
  let profileFormData = null;

  // Check if already enrolled
  try {
    const status = await window.scriptor.getAuthStatus();
    if (status.authenticated && status.enrolled) {
      showStep(-1);
      return;
    }
  } catch (_) { /* continue */ }

  // ── Navigation ─────────────────────────────────────
  function showStep(idx) {
    panels.forEach((p, i) => {
      p.style.display = i === idx ? 'block' : 'none';
    });
    successPanel.style.display = idx === -1 ? 'block' : 'none';

    segments.forEach((s, i) => {
      s.classList.remove('active', 'completed');
      if (idx === -1 || i < idx) s.classList.add('completed');
      else if (i === idx) s.classList.add('active');
    });

    currentStep = idx;
  }

  // ── Step 1: Authorization key ──────────────────────
  authKeyInput.addEventListener('input', () => {
    const pos = authKeyInput.selectionStart;
    const raw = authKeyInput.value;
    const clean = raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
    const formatted = clean.replace(/(.{4})(?=.)/g, '$1-');
    if (raw !== formatted) {
      authKeyInput.value = formatted;
      const addedHyphens = (formatted.slice(0, pos + 1).match(/-/g) || []).length -
                           (raw.slice(0, pos).match(/-/g) || []).length;
      authKeyInput.setSelectionRange(pos + addedHyphens, pos + addedHyphens);
    }
  });

  verifyKeyBtn.addEventListener('click', async () => {
    const key = authKeyInput.value.trim();
    step1Error.textContent = '';
    step1Org.style.display = 'none';

    if (!key) { step1Error.textContent = 'Enter an enrollment key to continue.'; return; }

    verifyKeyBtn.disabled = true;
    verifyKeyBtn.textContent = 'Verifying...';

    try {
      const result = await window.scriptor.verifyAuthKey(key);
      if (result.success) {
        orgId = result.orgId;
        orgName = result.orgName;
        step1Org.textContent = orgName;
        step1Org.style.display = 'block';
        setTimeout(() => {
          step2Org.textContent = orgName;
          showStep(1);
        }, 600);
      } else {
        step1Error.textContent = result.error || 'Invalid key. Check with your admin.';
      }
    } catch (err) {
      step1Error.textContent = err.message || 'Verification failed.';
    }

    verifyKeyBtn.disabled = false;
    verifyKeyBtn.textContent = 'Continue';
  });

  authKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyKeyBtn.click(); });

  // ── Step 2: Email ──────────────────────────────────
  async function doVerifyEmail() {
    step2Error.textContent = '';
    const email = emailInput.value.trim().toLowerCase();

    if (!email || !email.includes('@')) {
      step2Error.textContent = 'Enter a valid work email.';
      return;
    }

    verifyEmailBtn.disabled = true;
    verifyEmailBtn.textContent = 'Verifying...';

    try {
      const result = await window.scriptor.verifyEmail(email);
      if (result.success) {
        msEmail = email;
        step2Email.textContent = email;
        step2Email.style.display = 'block';

        if (result.alreadyEnrolled) {
          // Returning user
          if (result.needsMicrosoftSignIn) {
            const orgBadge = document.getElementById('step3-org-ms');
            setTimeout(() => {
              if (orgBadge) orgBadge.textContent = 'Welcome back, ' + (result.fullName || email);
              showStep(2);
              // For returning users: skip goes straight to success
              skipMsSignInBtn.onclick = () => goToSuccess('Welcome back', 'Scriptor is running.');
              msSignInBtn.onclick = async () => {
                step3MsError.textContent = '';
                msSignInBtn.disabled = true;
                msSignInBtn.textContent = 'Opening browser...';
                try {
                  const msResult = await window.scriptor.microsoftSignIn();
                  if (msResult.success) {
                    step3MsStatus.textContent = msResult.account?.username || 'Connected';
                    step3MsStatus.style.display = 'block';
                    msSignInBtn.textContent = 'Connected';
                    setTimeout(() => goToSuccess('Welcome back', 'Teams features activated.'), 800);
                  } else {
                    step3MsError.textContent = msResult.error || 'Sign-in failed.';
                    msSignInBtn.disabled = false;
                    msSignInBtn.textContent = 'Try again';
                  }
                } catch (err) {
                  step3MsError.textContent = err.message || 'Error';
                  msSignInBtn.disabled = false;
                  msSignInBtn.textContent = 'Try again';
                }
              };
            }, 600);
            return;
          }

          // Already enrolled, no MS needed
          setTimeout(() => goToSuccess('Welcome back', (result.fullName || email) + ' — Scriptor is running.'), 600);
          return;
        }

        // First-time user → Step 3
        setTimeout(() => {
          const orgBadge = document.getElementById('step3-org-ms');
          if (orgBadge) orgBadge.textContent = orgName;
          showStep(2);
        }, 600);
      } else {
        step2Error.textContent = result.error || 'Email not found. Contact your admin.';
        verifyEmailBtn.disabled = false;
        verifyEmailBtn.textContent = 'Continue';
      }
    } catch (err) {
      step2Error.textContent = err.message || 'Unexpected error.';
      verifyEmailBtn.disabled = false;
      verifyEmailBtn.textContent = 'Continue';
    }
  }

  verifyEmailBtn.addEventListener('click', doVerifyEmail);
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerifyEmail(); });

  // ── Step 3: MS Sign-In + Profile ───────────────────
  function showProfileForm() {
    profileSection.style.display = 'block';
    msSignInBtn.style.display = 'none';
    skipMsSignInBtn.style.display = 'none';
  }

  msSignInBtn.addEventListener('click', async () => {
    step3MsError.textContent = '';
    msSignInBtn.disabled = true;
    msSignInBtn.textContent = 'Opening browser...';

    try {
      const result = await window.scriptor.microsoftSignIn();
      if (result.success) {
        step3MsStatus.textContent = result.account?.username || 'Microsoft connected';
        step3MsStatus.style.display = 'block';
        msSignInBtn.textContent = 'Connected';
        setTimeout(showProfileForm, 600);
      } else {
        step3MsError.textContent = result.error || 'Sign-in failed. You can skip this.';
        msSignInBtn.disabled = false;
        resetMsButton();
      }
    } catch (err) {
      step3MsError.textContent = err.message || 'Sign-in error.';
      msSignInBtn.disabled = false;
      resetMsButton();
    }
  });

  function resetMsButton() {
    msSignInBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg> Try again';
  }

  skipMsSignInBtn.addEventListener('click', showProfileForm);

  // Role selector
  document.querySelectorAll('input[name="role"]').forEach(radio => {
    radio.addEventListener('change', () => {
      customRoleGroup.style.display = radio.value === 'Other' ? 'block' : 'none';
    });
  });

  continueToConsentBtn.addEventListener('click', () => {
    step3ProfileError.textContent = '';
    const firstName = firstNameInput.value.trim();
    const lastName = lastNameInput.value.trim();
    const roleRadio = document.querySelector('input[name="role"]:checked');
    const role = roleRadio ? roleRadio.value : null;
    const customRole = customRoleInput.value.trim();

    if (!firstName) { step3ProfileError.textContent = 'First name is required.'; return; }
    if (!lastName) { step3ProfileError.textContent = 'Last name is required.'; return; }
    if (!role) { step3ProfileError.textContent = 'Select a role.'; return; }
    if (role === 'Other' && !customRole) { step3ProfileError.textContent = 'Specify your role.'; return; }

    profileFormData = { firstName, lastName, role, customRole: role === 'Other' ? customRole : null };
    step4Org.textContent = orgName;
    showStep(3);
  });

  // ── Step 4: Consent + activate ─────────────────────
  consentCheckbox.addEventListener('change', () => {
    completeBtn.disabled = !consentCheckbox.checked;
  });

  completeBtn.addEventListener('click', async () => {
    step4Error.textContent = '';
    if (!consentCheckbox.checked) {
      step4Error.textContent = 'Consent required to continue.';
      return;
    }

    completeBtn.disabled = true;
    completeBtn.textContent = 'Activating...';

    try {
      const result = await window.scriptor.completeEnrollment({
        orgId,
        msEmail,
        firstName: profileFormData.firstName,
        lastName: profileFormData.lastName,
        role: profileFormData.role,
        customRole: profileFormData.customRole,
        consentGiven: true,
      });

      if (result.success) {
        goToSuccess("You're all set", 'Scriptor is running silently in the background.');
      } else {
        step4Error.textContent = result.error || 'Activation failed. Contact your admin.';
        completeBtn.disabled = false;
        completeBtn.textContent = 'Activate Scriptor';
      }
    } catch (err) {
      step4Error.textContent = err.message || 'Setup failed.';
      completeBtn.disabled = false;
      completeBtn.textContent = 'Activate Scriptor';
    }
  });

  // ── Success helper ─────────────────────────────────
  function goToSuccess(title, desc) {
    document.getElementById('success-title').textContent = title;
    document.getElementById('success-desc').textContent = desc;
    showStep(-1);
    setTimeout(() => window.scriptor.closeSetup(), 3500);
  }

  // ── Start ──────────────────────────────────────────
  showStep(0);
  authKeyInput.focus();
});
