// @ts-check

/**
 * Timeline webview client-side logic.
 * Communicates with the extension via postMessage.
 */
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // ── DOM references ─────────────────────────────────────────────────────
  const headerTitle = document.getElementById('headerTitle');
  const headerSubtitle = document.getElementById('headerSubtitle');
  const stepList = document.getElementById('stepList');
  const emptyState = document.getElementById('emptyState');
  const narrationText = document.getElementById('narrationText');
  const narrationPanel = document.getElementById('narrationPanel');
  const progressFill = document.getElementById('progressFill');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnPlayPause = document.getElementById('btnPlayPause');
  const speedSelect = document.getElementById('speedSelect');
  const btnFollow = document.getElementById('btnFollow');
  const reviewBar = document.getElementById('reviewBar');
  const reviewApproved = document.getElementById('reviewApproved');
  const reviewFlagged = document.getElementById('reviewFlagged');
  const reviewUnreviewed = document.getElementById('reviewUnreviewed');
  const btnRiskFilter = document.getElementById('btnRiskFilter');

  // ── State ──────────────────────────────────────────────────────────────
  let currentIndex = -1;
  let events = [];
  let visitedSteps = new Set();
  let playState = 'stopped';
  let speed = 1.0;
  let followEnabled = true;
  let collapsedSections = new Set(); // set of sectionStart event IDs
  let reviewSummary = { approved: 0, flagged: 0, unreviewed: 0 };
  let riskFilterActive = false;
  let commentInputEventId = null; // which step's comment input is showing

  // ── Icons per event type ───────────────────────────────────────────────
  var TYPE_ICONS = {
    openFile: '\u{1F4C4}',       // page
    showDiff: '\u{1F504}',       // arrows
    highlightRange: '\u{1F4CD}', // pin
    say: '\u{1F4AC}',            // speech
    sectionStart: '\u{1F4C1}',   // folder
    sectionEnd: '',               // not rendered
  };

  // ── Risk icons ─────────────────────────────────────────────────────────
  var RISK_ICONS = {
    security: '\u{1F6E1}',      // shield
    migration: '\u{1F4BE}',     // disk
    deletedTests: '\u26A0',     // warning
    publicApi: '\u{1F310}',     // globe
    newDependency: '\u{1F4E6}', // package
    largeChange: '\u{1F4C8}',   // chart
  };

  // ── Section tree builder ───────────────────────────────────────────────

  /**
   * Build a tree structure from the flat events array.
   * Returns an array of nodes: { type: 'section'|'step', event, index, children? }
   */
  function buildSectionTree(eventList) {
    var items = [];
    var sectionStack = [];

    eventList.forEach(function (event, index) {
      if (event.type === 'sectionStart') {
        var section = {
          type: 'section',
          event: event,
          index: index,
          children: [],
        };
        if (sectionStack.length > 0) {
          sectionStack[sectionStack.length - 1].children.push(section);
        } else {
          items.push(section);
        }
        sectionStack.push(section);
      } else if (event.type === 'sectionEnd') {
        if (sectionStack.length > 0) {
          sectionStack.pop();
        }
      } else {
        var step = { type: 'step', event: event, index: index };
        if (sectionStack.length > 0) {
          sectionStack[sectionStack.length - 1].children.push(step);
        } else {
          items.push(step);
        }
      }
    });

    return items;
  }

  // ── Check if event has risks ──────────────────────────────────────────

  function hasRisks(event) {
    return event.risks && event.risks.length > 0;
  }

  // ── Risk filter helper ────────────────────────────────────────────────

  function shouldShowStep(node) {
    if (!riskFilterActive) return true;
    if (node.type === 'section') {
      // Show section if any children have risks
      return node.children.some(shouldShowStep);
    }
    return hasRisks(node.event);
  }

  // ── Render helpers ─────────────────────────────────────────────────────

  function renderRiskBadges(risks) {
    var container = document.createElement('span');
    container.className = 'step-risks';
    (risks || []).forEach(function (risk) {
      var badge = document.createElement('span');
      badge.className = 'risk-badge ' + risk.category;
      badge.textContent = RISK_ICONS[risk.category] || '\u26A0';
      badge.title = risk.label;
      container.appendChild(badge);
    });
    return container;
  }

  function renderReviewButtons(event) {
    var container = document.createElement('span');
    container.className = 'step-actions';

    var review = event.review || { status: 'unreviewed' };

    // Approve button
    var approveBtn = document.createElement('button');
    approveBtn.className = 'review-btn approve' + (review.status === 'approved' ? ' active' : '');
    approveBtn.textContent = '\u2714'; // checkmark
    approveBtn.title = review.status === 'approved' ? 'Approved (click to clear)' : 'Approve';
    approveBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (review.status === 'approved') {
        vscode.postMessage({ command: 'clearReview', eventId: event.id });
      } else {
        vscode.postMessage({ command: 'approveStep', eventId: event.id });
      }
    });

    // Flag button
    var flagBtn = document.createElement('button');
    flagBtn.className = 'review-btn flag' + (review.status === 'flagged' ? ' active' : '');
    flagBtn.textContent = '\u2691'; // flag
    flagBtn.title = review.status === 'flagged' ? 'Flagged (click to clear)' : 'Flag for review';
    flagBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (review.status === 'flagged') {
        vscode.postMessage({ command: 'clearReview', eventId: event.id });
        if (commentInputEventId === event.id) {
          commentInputEventId = null;
          render();
        }
      } else {
        // Show comment input
        commentInputEventId = event.id;
        render();
      }
    });

    container.appendChild(approveBtn);
    container.appendChild(flagBtn);
    return container;
  }

  function renderCommentInput(event, indentLevel) {
    var row = document.createElement('div');
    row.className = 'comment-input-row' + (indentLevel > 0 ? ' indented' : '');
    if (indentLevel > 1) {
      row.style.paddingLeft = (16 + indentLevel * 16) + 'px';
    }

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'comment-input';
    input.placeholder = 'Add comment (optional)...';
    var existingComment = (event.review && event.review.comment) || '';
    input.value = existingComment;

    var submitBtn = document.createElement('button');
    submitBtn.className = 'comment-submit';
    submitBtn.textContent = 'Flag';
    submitBtn.addEventListener('click', function () {
      vscode.postMessage({
        command: 'flagStep',
        eventId: event.id,
        comment: input.value || undefined,
      });
      commentInputEventId = null;
      render();
    });

    // Also submit on Enter
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        submitBtn.click();
      } else if (e.key === 'Escape') {
        commentInputEventId = null;
        render();
      }
    });

    row.appendChild(input);
    row.appendChild(submitBtn);

    // Focus input after render
    setTimeout(function () { input.focus(); }, 0);

    return row;
  }

  function renderSectionHeader(node, indentLevel) {
    if (!shouldShowStep(node)) return null;

    var isCollapsed = collapsedSections.has(node.event.id);
    var isCurrent = node.index === currentIndex;

    var wrapper = document.createElement('div');
    wrapper.className = 'section-group' + (isCollapsed ? ' section-collapsed' : '');

    var header = document.createElement('div');
    header.className = 'section-header' + (isCurrent ? ' current' : '');
    if (indentLevel > 0) {
      header.style.paddingLeft = (16 + indentLevel * 16) + 'px';
    }

    var arrow = document.createElement('span');
    arrow.className = 'section-arrow';
    arrow.textContent = '\u25BC'; // down triangle

    var title = document.createElement('span');
    title.className = 'section-title';
    title.textContent = node.event.title;

    var count = document.createElement('span');
    count.className = 'section-count';
    var childStepCount = countSteps(node.children);
    count.textContent = '(' + childStepCount + ' step' + (childStepCount !== 1 ? 's' : '') + ')';

    header.appendChild(arrow);
    header.appendChild(title);
    header.appendChild(count);

    header.addEventListener('click', function () {
      if (collapsedSections.has(node.event.id)) {
        collapsedSections.delete(node.event.id);
      } else {
        collapsedSections.add(node.event.id);
      }
      render();
    });

    wrapper.appendChild(header);

    var childrenDiv = document.createElement('div');
    childrenDiv.className = 'section-children';
    renderNodes(node.children, childrenDiv, indentLevel + 1);
    wrapper.appendChild(childrenDiv);

    return wrapper;
  }

  function renderStepItem(node, indentLevel) {
    if (!shouldShowStep(node)) return null;

    var event = node.event;
    var index = node.index;
    var review = event.review || { status: 'unreviewed' };

    var item = document.createElement('div');
    item.className = 'step-item';
    if (indentLevel > 0) item.classList.add('indented');
    if (index === currentIndex) item.classList.add('current');
    if (visitedSteps.has(index)) item.classList.add('visited');
    if (hasRisks(event)) item.classList.add('has-risks');
    if (review.status === 'approved') item.classList.add('reviewed-approved');
    if (review.status === 'flagged') item.classList.add('reviewed-flagged');

    if (indentLevel > 1) {
      item.style.paddingLeft = (16 + indentLevel * 16) + 'px';
    }

    var num = document.createElement('span');
    num.className = 'step-number';
    num.textContent = String(index + 1);

    var icon = document.createElement('span');
    icon.className = 'step-icon';
    icon.textContent = TYPE_ICONS[event.type] || '\u2022';

    var title = document.createElement('span');
    title.className = 'step-title';
    title.textContent = event.title;

    item.appendChild(num);
    item.appendChild(icon);
    item.appendChild(title);

    // Risk badges
    if (hasRisks(event)) {
      item.appendChild(renderRiskBadges(event.risks));
    }

    // Review buttons
    item.appendChild(renderReviewButtons(event));

    item.addEventListener('click', function () {
      vscode.postMessage({ command: 'goToStep', index: index });
    });

    return item;
  }

  function renderNodes(nodes, container, indentLevel) {
    nodes.forEach(function (node) {
      var element;
      if (node.type === 'section') {
        element = renderSectionHeader(node, indentLevel);
      } else {
        element = renderStepItem(node, indentLevel);
      }
      if (element) {
        container.appendChild(element);
        // Show comment input if this is the step being flagged
        if (node.type === 'step' && commentInputEventId === node.event.id) {
          container.appendChild(renderCommentInput(node.event, indentLevel));
        }
      }
    });
  }

  function countSteps(nodes) {
    var count = 0;
    nodes.forEach(function (node) {
      if (node.type === 'step') {
        if (shouldShowStep(node)) count++;
      } else if (node.type === 'section' && node.children) {
        count += countSteps(node.children);
      }
    });
    return count;
  }

  // ── Update review bar ─────────────────────────────────────────────────

  function updateReviewBar() {
    if (events.length === 0) {
      reviewBar.style.display = 'none';
      return;
    }

    reviewBar.style.display = 'flex';
    reviewApproved.innerHTML = '\u2714 ' + reviewSummary.approved;
    reviewFlagged.innerHTML = '\u2691 ' + reviewSummary.flagged;
    reviewUnreviewed.innerHTML = '\u25CB ' + reviewSummary.unreviewed;

    // Count risky steps
    var riskyCount = events.filter(hasRisks).length;
    if (riskyCount > 0) {
      btnRiskFilter.textContent = '\u26A0 ' + riskyCount + ' Risk' + (riskyCount !== 1 ? 's' : '');
      btnRiskFilter.style.display = 'inline-block';
    } else {
      btnRiskFilter.style.display = 'none';
    }

    if (riskFilterActive) {
      btnRiskFilter.classList.add('active');
    } else {
      btnRiskFilter.classList.remove('active');
    }
  }

  // ── Main render ────────────────────────────────────────────────────────

  function render() {
    if (events.length === 0) {
      emptyState.style.display = 'block';
      narrationPanel.style.display = 'none';
      document.getElementById('controls').style.display = 'none';
      headerTitle.textContent = 'No replay loaded';
      headerSubtitle.textContent = '';
      progressFill.style.width = '0%';
      reviewBar.style.display = 'none';
      return;
    }

    emptyState.style.display = 'none';
    narrationPanel.style.display = 'block';
    document.getElementById('controls').style.display = 'flex';

    // Header
    var fileCount = new Set(events.filter(function (e) { return e.filePath; }).map(function (e) { return e.filePath; })).size;
    headerTitle.textContent = 'Replay Session';
    headerSubtitle.textContent = events.length + ' steps' + (fileCount > 0 ? ' \u00B7 ' + fileCount + ' files' : '');

    // Progress bar
    if (events.length > 0 && currentIndex >= 0) {
      var pct = ((currentIndex + 1) / events.length) * 100;
      progressFill.style.width = pct + '%';
    } else {
      progressFill.style.width = '0%';
    }

    // Review bar
    updateReviewBar();

    // Step list — build tree and render
    stepList.innerHTML = '';
    var tree = buildSectionTree(events);
    renderNodes(tree, stepList, 0);

    // Scroll current step into view
    var currentItem = stepList.querySelector('.step-item.current, .section-header.current');
    if (currentItem) {
      currentItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    // Narration
    if (currentIndex >= 0 && currentIndex < events.length) {
      narrationText.textContent = events[currentIndex].narration || '';
    } else {
      narrationText.textContent = '';
    }

    // Navigation buttons
    btnPrev.disabled = currentIndex <= 0;
    btnNext.disabled = currentIndex >= events.length - 1;

    // Play/pause button
    updatePlayButton();
    updateSpeedSelect();
    updateFollowButton();
  }

  // ── Control updates ────────────────────────────────────────────────────

  function updatePlayButton() {
    if (playState === 'playing') {
      btnPlayPause.innerHTML = '&#10074;&#10074;'; // pause icon
      btnPlayPause.title = 'Pause (Space)';
    } else {
      btnPlayPause.innerHTML = '&#9654;'; // play icon
      btnPlayPause.title = 'Play (Space)';
    }
  }

  function updateSpeedSelect() {
    speedSelect.value = String(speed);
  }

  function updateFollowButton() {
    if (followEnabled) {
      btnFollow.classList.add('active');
      btnFollow.title = 'Following (click to free)';
      btnFollow.textContent = '\u{1F441}'; // eye
    } else {
      btnFollow.classList.remove('active');
      btnFollow.title = 'Free (click to follow)';
      btnFollow.textContent = '\u{1F440}'; // eyes
    }
  }

  // ── Button handlers ────────────────────────────────────────────────────

  btnPrev.addEventListener('click', function () {
    vscode.postMessage({ command: 'previous' });
  });

  btnNext.addEventListener('click', function () {
    vscode.postMessage({ command: 'next' });
  });

  btnPlayPause.addEventListener('click', function () {
    vscode.postMessage({ command: 'togglePlayPause' });
  });

  speedSelect.addEventListener('change', function () {
    vscode.postMessage({ command: 'setSpeed', speed: parseFloat(speedSelect.value) });
  });

  btnFollow.addEventListener('click', function () {
    vscode.postMessage({ command: 'toggleFollowMode' });
  });

  btnRiskFilter.addEventListener('click', function () {
    riskFilterActive = !riskFilterActive;
    render();
  });

  // ── Messages from extension ────────────────────────────────────────────

  window.addEventListener('message', function (event) {
    var msg = event.data;

    switch (msg.command) {
      case 'updateState':
        events = msg.events || [];
        currentIndex = msg.currentIndex;
        playState = msg.playState || 'stopped';
        speed = msg.speed || 1.0;
        followEnabled = msg.followEnabled !== false;
        reviewSummary = msg.reviewSummary || { approved: 0, flagged: 0, unreviewed: 0 };
        if (currentIndex >= 0) {
          visitedSteps.add(currentIndex);
        }
        render();
        break;

      case 'clearSession':
        events = [];
        currentIndex = -1;
        visitedSteps = new Set();
        playState = 'stopped';
        speed = 1.0;
        followEnabled = true;
        collapsedSections = new Set();
        reviewSummary = { approved: 0, flagged: 0, unreviewed: 0 };
        riskFilterActive = false;
        commentInputEventId = null;
        render();
        break;
    }
  });

  // ── Initial render ─────────────────────────────────────────────────────
  render();
})();
