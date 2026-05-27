// Theme management
(function() {
    // Initialize theme from localStorage or default to light
    function initTheme() {
        const savedTheme = localStorage.getItem('admin-theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);
    }

    // Toggle theme
    function toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('admin-theme', newTheme);
    }

    // Make toggleTheme available globally
    window.toggleTheme = toggleTheme;

    // Initialize theme on page load
    initTheme();
})();
