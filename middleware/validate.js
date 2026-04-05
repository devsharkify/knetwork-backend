const Joi = require('joi');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], { abortEarly: false, stripUnknown: true });
    if (error) {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.details.map(d => ({ field: d.path.join('.'), message: d.message }))
      });
    }
    req[source] = value;
    next();
  };
}

// Schemas
const schemas = {
  register: Joi.object({
    full_name: Joi.string().min(2).max(100).required(),
    batch_year: Joi.number().integer().min(1997).max(2030).required(),
    program: Joi.string().valid('mba_fulltime','mba_parttime','epgp','phd_fellow','exec_education').required(),
    roll_number: Joi.string().max(30).optional().allow(''),
    personal_email: Joi.string().email().required(),
    whatsapp_number: Joi.string().pattern(/^\d{8,15}$/).required(),
    whatsapp_country_code: Joi.string().default('+91'),
    city: Joi.string().required(),
    linkedin_url: Joi.string().uri().optional().allow(''),
    goals: Joi.array().items(Joi.string()).max(10).default([]),
    tag_ids: Joi.array().items(Joi.string().uuid()).max(20).default([]),
    group_ids: Joi.array().items(Joi.string().uuid()).max(10).default([])
  }),

  updateProfile: Joi.object({
    current_title: Joi.string().max(120).optional(),
    current_company: Joi.string().max(120).optional(),
    bio: Joi.string().max(500).optional().allow(''),
    city: Joi.string().optional(),
    linkedin_url: Joi.string().uri().optional().allow(''),
    visibility: Joi.string().valid('all_alumni','connections_only','private').optional(),
    kmatch_active: Joi.boolean().optional(),
    wa_notifications: Joi.boolean().optional(),
    email_digest: Joi.boolean().optional()
  }),

  postOpp: Joi.object({
    type: Joi.string().valid('job','investment','biz_collab','mentorship','cofounder').required(),
    title: Joi.string().min(5).max(200).required(),
    company: Joi.string().max(120).optional().allow(''),
    location: Joi.string().max(100).optional().allow(''),
    description: Joi.string().min(20).max(2000).required(),
    tags: Joi.array().items(Joi.string().uuid()).max(10).default([]),
    notify_groups: Joi.array().items(Joi.string().uuid()).max(8).default([]),
    salary_range: Joi.string().max(50).optional().allow(''),
    raise_amount: Joi.string().max(50).optional().allow(''),
    mentor_slots: Joi.number().integer().min(1).max(20).optional(),
    mentor_mode: Joi.string().max(50).optional().allow(''),
    expires_at: Joi.string().isoDate().optional()
  }),

  postFeed: Joi.object({
    body: Joi.string().min(10).max(3000).required(),
    post_type: Joi.string().valid('update','job_post','startup','event_promo','insight','ask','announcement').required(),
    tags: Joi.array().items(Joi.string().uuid()).max(8).default([]),
    visibility: Joi.string().valid('all_alumni','connections_only').default('all_alumni')
  }),

  eventCheckin: Joi.object({
    event_id: Joi.string().uuid().required()
  }),

  connectRequest: Joi.object({
    recipient_id: Joi.string().uuid().required(),
    note: Joi.string().max(500).optional().allow('')
  }),

  warmIntro: Joi.object({
    target_id: Joi.string().uuid().required(),
    connector_id: Joi.string().uuid().required(),
    message: Joi.string().max(500).optional().allow('')
  }),

  syndicateParticipate: Joi.object({
    deal_id: Joi.string().uuid().required(),
    amount_lakh: Joi.number().min(1).max(1000).required()
  }),

  broadcastWA: Joi.object({
    group_id: Joi.string().uuid().optional(),
    chapter_city: Joi.string().optional(),
    template_name: Joi.string().required(),
    custom_message: Joi.string().max(1000).optional().allow('')
  }),

  createEvent: Joi.object({
    title: Joi.string().min(5).max(200).required(),
    event_type: Joi.string().valid('mixer','summit','dinner','webinar','workshop','conference','reunion').required(),
    chapter: Joi.string().required(),
    chapter_display: Joi.string().optional(),
    description: Joi.string().max(2000).optional().allow(''),
    venue: Joi.string().max(200).optional().allow(''),
    event_date: Joi.string().isoDate().required(),
    event_time: Joi.string().optional(),
    capacity: Joi.number().integer().min(5).max(5000).optional(),
    ticket_price: Joi.number().min(0).default(0),
    is_invitation_only: Joi.boolean().default(false),
    tags: Joi.array().items(Joi.string().uuid()).default([])
  }),

  submitPitch: Joi.object({
    startup_name: Joi.string().min(2).max(100).required(),
    sector_tag_id: Joi.string().uuid().optional(),
    stage: Joi.string().valid('idea','mvp','seed','pre_series_a','series_a','series_b_plus','pre_ipo').required(),
    one_liner: Joi.string().max(200).required(),
    description: Joi.string().max(2000).optional().allow(''),
    deck_url: Joi.string().uri().optional().allow(''),
    raise_amount_lakh: Joi.number().min(0).optional(),
    raise_structure: Joi.string().max(50).optional().allow(''),
    metrics: Joi.object().optional()
  })
};

module.exports = { validate, schemas };
