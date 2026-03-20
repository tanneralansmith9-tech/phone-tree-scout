(function() {
  if (document.getElementById('scout-overlay')) {
    document.getElementById('scout-overlay').remove();
    return;
  }

  var url = window.location.href;
  var companyMatch = url.match(/record\/0-2\/(\d+)/);
  if (!companyMatch) {
    alert('Open a HubSpot Company record first, then click Scout.');
    return;
  }
  var companyId = companyMatch[1];

  var nameEl = document.querySelector('[data-test-id="record-title"]') 
    || document.querySelector('h1[class*="title"]')
    || document.querySelector('h1');
  var companyName = nameEl ? nameEl.textContent.trim() : '';

  var phoneEl = document.querySelector('a[href^="tel:"]');
  var phone = phoneEl ? phoneEl.textContent.trim() : '';

  var overlay = document.createElement('div');
  overlay.id = 'scout-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;';
  
  overlay.innerHTML = ''
    + '<div style="background:white;padding:32px;border-radius:16px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">'
    + '  <div style="text-align:center;margin-bottom:20px;">'
    + '    <div style="font-size:36px;margin-bottom:8px;">📞</div>'
    + '    <h2 style="margin:0;font-size:22px;color:#1a1a1a;">Phone Tree Scout</h2>'
    + '    <p style="margin:4px 0 0;color:#666;font-size:14px;">Map this company\'s phone tree</p>'
    + '  </div>'
    + '  <div style="margin-bottom:16px;">'
    + '    <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px;">Company Name</label>'
    + '    <input id="scout-name" type="text" value="' + companyName.replace(/"/g, '&quot;') + '" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box;" />'
    + '  </div>'
    + '  <div style="margin-bottom:20px;">'
    + '    <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px;">Phone Number</label>'
    + '    <input id="scout-phone" type="text" value="' + phone + '" placeholder="+1 (800) 555-1234" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;box-sizing:border-box;" />'
    + '  </div>'
    + '  <button id="scout-fire" style="width:100%;padding:14px;background:#7c3aed;color:white;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;">🚀 Map Phone Tree</button>'
    + '  <div id="scout-status" style="text-align:center;margin-top:14px;font-size:14px;min-height:20px;color:#7c3aed;font-weight:500;"></div>'
    + '  <button id="scout-close" style="display:block;width:100%;margin-top:10px;padding:10px;background:none;border:1px solid #e5e7eb;border-radius:8px;font-size:14px;color:#666;cursor:pointer;">Close</button>'
    + '</div>';

  document.body.appendChild(overlay);

  document.getElementById('scout-close').onclick = function() { overlay.remove(); };
  overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };

  document.getElementById('scout-fire').onclick = function() {
    var name = document.getElementById('scout-name').value.trim();
    var phoneRaw = document.getElementById('scout-phone').value.trim();
    var statusEl = document.getElementById('scout-status');
    var btn = document.getElementById('scout-fire');

    if (!phoneRaw) {
      statusEl.style.color = '#ef4444';
      statusEl.textContent = 'Please enter a phone number.';
      return;
    }

    var cleanPhone = phoneRaw.replace(/[^0-9+]/g, '');
    if (!cleanPhone.startsWith('+')) cleanPhone = '+1' + cleanPhone;

    btn.disabled = true;
    btn.style.background = '#a78bfa';
    btn.textContent = 'Calling...';
    statusEl.style.color = '#7c3aed';
    statusEl.textContent = 'Initiating call to ' + cleanPhone + '...';

    fetch('https://phone-tree-scout.onrender.com/twilio/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toNumber: cleanPhone, companyId: companyId, companyName: name || 'Unknown Company' })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) {
        statusEl.style.color = '#ef4444';
        statusEl.textContent = data.error;
        btn.disabled = false;
        btn.style.background = '#7c3aed';
        btn.textContent = '🚀 Map Phone Tree';
        return;
      }
      btn.style.background = '#059669';
      btn.textContent = '✅ Call Started!';
      statusEl.style.color = '#059669';
      statusEl.innerHTML = 'Scout is mapping the phone tree.<br>Note will appear on this record in ~2 min.<br><br><a href="' + data.dashboardUrl + '" target="_blank" style="color:#7c3aed;font-weight:600;">Open Live Dashboard</a>';
    })
    .catch(function(err) {
      statusEl.style.color = '#ef4444';
      statusEl.textContent = 'Connection error: ' + err.message;
      btn.disabled = false;
      btn.style.background = '#7c3aed';
      btn.textContent = '🚀 Map Phone Tree';
    });
  };
})();
