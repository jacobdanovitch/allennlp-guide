// This outline builds our chapter navigation structure, grouped by Part.

// Supported `icon` values:   'stack', 'rocket', 'cube', 'tools' and 'default' (generic text icon)
// Supported `color` values:   'aqua', 'orange', 'purpe', 'blue' and 'default' (generic neutral color)
// If more parts need to be added then consider adding additional icon assets to src/components/inlineSVG/
// and additional color gradients to src/pages/index.js

export const outline = {
    // See overview.md for title and description of this standalone chapter.
    overview: {
        slug: '/overview',
        icon: 'stack',
        color: 'aqua'
    },
    parts: [
        {
            title: 'Part 1: Quick Start',
            description: 'Part 1 gives you a quick walk-through of main AllenNLP concepts and features. We’ll build a complete, working NLP model (text classifier) along the way.',
            chapterSlugs: [
                '/introduction',
                '/your-first-model',
                '/training-and-prediction',
                '/next-steps'
            ],
            icon: 'rocket',
            color: 'orange'
        },
        {
            title: 'Part 2: Abstractions, Design, and Testing',
            description: 'Part 2 provides in-depth tutorials on individual abstractions and features of AllenNLP.',
            chapterSlugs: [
                '/reading-textual-data',
                '/building-your-model',
                '/common-architectures',
                '/representing-text-as-features'
            ],
            icon: 'cube',
            color: 'purple'
        },
        {
            title: 'Part 3: Practical Tasks With AllenNLP',
            description: 'Part 3 introduces common NLP tasks and how to build models for these tasks using AllenNLP.',
            chapterSlugs: [
                '/semantic-parsing'
            ],
            icon: 'tools',
            color: 'blue'
        }
    ]
};
