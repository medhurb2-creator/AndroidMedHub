// frontend-user/scripts/help.js

/**
 * MedVix Help System
 * Manages the help overlay with FAQ, tutorials, and contact support.
 * Completely independent from notifications.js.
 */

import * as ui from './ui.js';
import * as utils from './utils.js';

// ==================== DATA ====================

const FAQ = [
    {
        question: 'How do I take an exam?',
        answer: 'Go to Subjects, select a subject, choose your topics, and tap "Start Exam".'
    },
    {
        question: 'What is a Challenge?',
        answer: 'A Challenge lets you compete with friends or other students on the same exam set. Create or join a challenge using a code.'
    },
    {
        question: 'How do I view my results?',
        answer: 'After completing an exam, you\'ll see your results immediately. You can also view past results in the Performance page.'
    },
    {
        question: 'How do I earn achievements?',
        answer: 'Achievements are unlocked by reaching milestones like perfect scores, speed records, or high ranks.'
    },
    {
        question: 'What is the AI Tutor?',
        answer: 'The AI Tutor helps you with explanations, study plans, and practice questions. Tap the AI icon in the footer.'
    },
    {
        question: 'How do I update my subscription?',
        answer: 'Go to your Profile and tap "Subscription" or visit the Subscription page from the menu.'
    },
    {
        question: 'Can I study offline?',
        answer: 'Yes! All questions and notes are stored locally. You can study without an internet connection.'
    },
    {
        question: 'How do I contact support?',
        answer: 'Use the contact options below. We\'re here to help!'
    }
];

const TUTORIALS = [
    {
        title: 'Getting Started',
        steps: [
            'Sign up or log in.',
            'Select a subject from the Subjects page.',
            'Choose topics and start an exam.',
            'Review your results and track progress.'
        ]
    },
    {
        title: 'Challenge Mode',
        steps: [
            'Go to Exam Settings and select Challenge Mode.',
            'Create a challenge or join with a code.',
            'Complete the exam and compare scores.'
        ]
    },
    {
        title: 'Using AI Tutor',
        steps: [
            'Tap the AI icon in the footer.',
            'Ask a question or request a summary.',
            'Get explanations, flashcards, or practice questions.'
        ]
    }
];

// ==================== RENDER HELP ====================

export function renderHelp(container) {
    container.innerHTML = '';
    
    const panel = document.createElement('div');
    panel.className = 'help-panel';
    
    // Header
    const header = document.createElement('div');
    header.className = 'help-header';
    header.innerHTML = `
        <h2>Help & Support</h2>
        <button class="help-close" onclick="document.getElementById('helpOverlay').style.display='none'">✕</button>
    `;
    panel.appendChild(header);
    
    // Search
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'help-search';
    search.placeholder = 'Search help...';
    search.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        document.querySelectorAll('.faq-item').forEach(item => {
            const text = item.textContent.toLowerCase();
            item.style.display = text.includes(q) ? '' : 'none';
        });
    });
    panel.appendChild(search);
    
    // FAQ
    const faqTitle = document.createElement('h3');
    faqTitle.textContent = 'Frequently Asked Questions';
    panel.appendChild(faqTitle);
    
    FAQ.forEach(item => {
        const div = document.createElement('div');
        div.className = 'faq-item';
        div.innerHTML = `
            <div class="question">
                <span>${item.question}</span>
                <span>▼</span>
            </div>
            <div class="answer">${item.answer}</div>
        `;
        div.addEventListener('click', () => {
            div.classList.toggle('open');
        });
        panel.appendChild(div);
    });
    
    // Tutorials
    const tutTitle = document.createElement('h3');
    tutTitle.textContent = 'Quick Tutorials';
    panel.appendChild(tutTitle);
    
    TUTORIALS.forEach(tut => {
        const div = document.createElement('div');
        div.className = 'faq-item';
        div.innerHTML = `
            <div class="question">
                <span>📘 ${tut.title}</span>
                <span>▼</span>
            </div>
            <div class="answer">
                <ol>${tut.steps.map(s => `<li>${s}</li>`).join('')}</ol>
            </div>
        `;
        div.addEventListener('click', () => {
            div.classList.toggle('open');
        });
        panel.appendChild(div);
    });
    
    // Contact
    const contactTitle = document.createElement('h3');
    contactTitle.textContent = 'Contact Support';
    panel.appendChild(contactTitle);
    
    const contacts = document.createElement('div');
    contacts.className = 'help-contacts';
    contacts.innerHTML = `
        <button onclick="window.location.href='mailto:felixappbuilder@gmail.com'">✉️ Email</button>
        <button onclick="window.location.href='tel:+254746834527'">📱 Call</button>
        <button onclick="window.open('https://wa.me/254746834527','_blank')">💬 WhatsApp</button>
        <button onclick="window.open('https://forms.gle/your-form-link','_blank')">🐛 Report Bug</button>
    `;
    panel.appendChild(contacts);
    
    // Release notes
    const notes = document.createElement('p');
    notes.style.marginTop = '1.5rem';
    notes.style.fontSize = '0.8rem';
    notes.style.color = 'var(--text-muted)';
    notes.textContent = 'MedVix v1.0.0 • Built with ❤️ in Kenya';
    panel.appendChild(notes);
    
    container.appendChild(panel);
}

// ==================== EXPOSE GLOBALLY ====================

window.help = {
    renderHelp
};

export default { renderHelp };