import mongoose from 'mongoose';

const ruleSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    workspaceId: {
        type: String,
        default: 'default',
        index: true
    },
    extensionRuleId: {
        type: Number,
        required: true
    },
    type: {
        type: String,
        enum: ['redirect', 'header', 'mock', 'delay'],
        required: true
    },
    urlFilter: {
        type: String,
    },
    config: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Compound index to quickly fetch a user's rules
ruleSchema.index({ userId: 1, workspaceId: 1 });

export const Rule = mongoose.model('Rule', ruleSchema);
