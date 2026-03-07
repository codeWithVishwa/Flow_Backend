// Centralized, styled email templates for transactional emails
// Keep styles inline for broad email client support

export const generateVerifyEmailTemplate = (name, link) => {
  const logoUrl = process.env.EMAIL_LOGO_URL || 'https://res.cloudinary.com/dli1zwoz8/image/upload/v1763968442/icon_h8kza6.png';
  const logoBlock = logoUrl
    ? `<div style="text-align:center;padding:18px 0 4px"><img src='${logoUrl}' alt='Logo' style='width:72px;height:auto;display:inline-block;border-radius:12px' /></div>`
    : '';
  return `
  <div style="font-family:'Segoe UI',sans-serif;background:#f9f9f9;padding:20px">
    <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;
      box-shadow:0 2px 6px rgba(0,0,0,0.1)">
      ${logoBlock}
      <div style="background:#007bff;color:white;text-align:center;padding:16px 0;font-size:20px">
        Welcome to Flowsnap 💙
      </div>
      <div style="padding:25px;font-size:15px;color:#333">
        <p>Hi <strong>${name || "there"}</strong>,</p>
        <p>Thanks for signing up! Please verify your email by clicking the button below:</p>
        <div style="text-align:center;margin:25px 0;">
          <a href="${link}" style="background:#007bff;color:white;padding:10px 22px;
            text-decoration:none;border-radius:6px;font-weight:600;display:inline-block">Verify Email</a>
        </div>
        <p>If that doesn’t work, copy and paste this link in your browser:</p>
        <p style="background:#f3f3f3;padding:10px;border-radius:5px;word-break:break-all">${link}</p>
        <p style="font-size:13px;color:#666;">This link expires in 24 hours.</p>
      </div>
    </div>
  </div>
`;
};

export const generateResetPasswordTemplate = (name, link) => {
  const logoUrl = process.env.EMAIL_LOGO_URL || 'https://res.cloudinary.com/dli1zwoz8/image/upload/v1763968442/icon_h8kza6.png';
  const logoBlock = logoUrl
    ? `<div style="text-align:center;padding:18px 0 4px"><img src='${logoUrl}' alt='Logo' style='width:72px;height:auto;display:inline-block;border-radius:12px' /></div>`
    : '';
  return `
  <div style="font-family:'Segoe UI',sans-serif;background:#f9f9f9;padding:20px">
    <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;
      box-shadow:0 2px 6px rgba(0,0,0,0.1)">
      ${logoBlock}
      <div style="background:#ff9800;color:white;text-align:center;padding:16px 0;font-size:20px">
        Reset your password
      </div>
      <div style="padding:25px;font-size:15px;color:#333">
        <p>Hi <strong>${name || "there"}</strong>,</p>
        <p>We received a request to reset your password. Click the button below to set a new password:</p>
        <div style="text-align:center;margin:25px 0;">
          <a href="${link}" style="background:#ff9800;color:white;padding:10px 22px;
            text-decoration:none;border-radius:6px;font-weight:600;display:inline-block">Reset Password</a>
        </div>
        <p>If the button doesn’t work, copy and paste this link in your browser:</p>
        <p style="background:#f3f3f3;padding:10px;border-radius:5px;word-break:break-all">${link}</p>
        <p style="font-size:13px;color:#666;">This link expires in 1 hour. If you didn’t request this, you can safely ignore this email.</p>
      </div>
    </div>
  </div>
`;
};

// OTP-based templates
export const generateVerifyEmailOtpTemplate = (name, code) => {
  const logoUrl = process.env.EMAIL_LOGO_URL || 'https://res.cloudinary.com/dli1zwoz8/image/upload/v1763968442/icon_h8kza6.png';
  const logoBlock = logoUrl
    ? `<div style="text-align:center;padding:26px 0 8px"><img src='${logoUrl}' alt='Logo' style='width:88px;height:auto;display:inline-block;border-radius:16px' /></div>`
    : '';
  return `
  <div style="font-family:'Segoe UI',sans-serif;background:#0d0d0d;padding:30px">
    <div style="max-width:600px;margin:auto;background:#1a1a1a;border-radius:14px;overflow:hidden;
      border:1px solid rgba(168,19,166,0.35);
      box-shadow:0 0 25px rgba(168,19,166,0.35)">
      ${logoBlock}
      <div style="background:#a813a6ff;color:white;text-align:center;padding:18px 0;
        font-size:22px;font-weight:600;letter-spacing:1px">
        Verify Your Email
      </div>

      <div style="padding:30px;font-size:15px;color:#e6e6e6;line-height:1.7">
        <p style="margin:0 0 12px">Hi <strong>${name || 'there'}</strong>,</p>

        <p style="margin:0 0 22px;color:#cccccc">
          Use the verification code below inside the app to activate your account:
        </p>

        <div style="text-align:center;margin:28px 0;font-size:36px;letter-spacing:8px;
          font-weight:700;color:#a813a6ff;
          text-shadow:0 0 12px rgba(168,19,166,0.9), 0 0 20px rgba(168,19,166,0.6)">
          ${code}
        </div>

        <p style="font-size:13px;color:#888;margin-top:25px">
          This code expires in 10 minutes. If it expires you can request a new one.
        </p>
      </div>

    </div>
  </div>
`;
};


export const generateResetPasswordOtpTemplate = (name, code) => {
  const logoUrl = process.env.EMAIL_LOGO_URL || 'https://res.cloudinary.com/dli1zwoz8/image/upload/v1763968442/icon_h8kza6.png';
  const logoBlock = logoUrl
    ? `<div style="text-align:center;padding:26px 0 8px"><img src='${logoUrl}' alt='Logo' style='width:88px;height:auto;display:inline-block;border-radius:16px' /></div>`
    : '';
  return `
  <div style="font-family:'Segoe UI',sans-serif;background:#0d0d0d;padding:30px">
    <div style="max-width:600px;margin:auto;background:#1a1a1a;border-radius:14px;overflow:hidden;
      border:1px solid rgba(168,19,166,0.35);
      box-shadow:0 0 25px rgba(168,19,166,0.35)">
      ${logoBlock}
      <div style="background:#a813a6ff;color:white;text-align:center;padding:18px 0;
        font-size:22px;font-weight:600;letter-spacing:1px">
        Password Reset Code
      </div>

      <div style="padding:30px;font-size:15px;color:#e6e6e6;line-height:1.7">
        <p style="margin:0 0 12px">Hi <strong>${name || 'there'}</strong>,</p>

        <p style="margin:0 0 22px;color:#cccccc">
          Use the code below inside the app to reset your password:
        </p>

        <div style="text-align:center;margin:28px 0;font-size:36px;letter-spacing:8px;
          font-weight:700;color:#a813a6ff;
          text-shadow:0 0 12px rgba(168,19,166,0.9), 0 0 20px rgba(168,19,166,0.6)">
          ${code}
        </div>

        <p style="font-size:13px;color:#888;margin-top:25px">
          This code expires in 10 minutes. If you did not request a reset, you can ignore this email.
        </p>
      </div>

    </div>
  </div>
`;
};

export const generateVaultPinResetOtpTemplate = (name, code) => {
  const logoUrl = process.env.EMAIL_LOGO_URL || 'https://res.cloudinary.com/dli1zwoz8/image/upload/v1763968442/icon_h8kza6.png';
  const logoBlock = logoUrl
    ? `<div style="text-align:center;padding:26px 0 8px"><img src='${logoUrl}' alt='Logo' style='width:88px;height:auto;display:inline-block;border-radius:16px' /></div>`
    : '';
  return `
  <div style="font-family:'Segoe UI',sans-serif;background:#0d0d0d;padding:30px">
    <div style="max-width:600px;margin:auto;background:#1a1a1a;border-radius:14px;overflow:hidden;
      border:1px solid rgba(168,19,166,0.35);
      box-shadow:0 0 25px rgba(168,19,166,0.35)">
      ${logoBlock}
      <div style="background:#a813a6ff;color:white;text-align:center;padding:18px 0;
        font-size:22px;font-weight:600;letter-spacing:1px">
        Message Vault PIN Reset
      </div>

      <div style="padding:30px;font-size:15px;color:#e6e6e6;line-height:1.7">
        <p style="margin:0 0 12px">Hi <strong>${name || 'there'}</strong>,</p>

        <p style="margin:0 0 22px;color:#cccccc">
          Use the code below inside the app to reset your Message Vault PIN:
        </p>

        <div style="text-align:center;margin:28px 0;font-size:36px;letter-spacing:8px;
          font-weight:700;color:#a813a6ff;
          text-shadow:0 0 12px rgba(168,19,166,0.9), 0 0 20px rgba(168,19,166,0.6)">
          ${code}
        </div>

        <p style="font-size:13px;color:#888;margin-top:25px">
          This code expires in 10 minutes. If you did not request this, you can ignore this email.
        </p>
      </div>

    </div>
  </div>
`;
};

