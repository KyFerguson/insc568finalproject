const https = require("https");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const notificationQueue = require("./notificationQueue");
const mockEmailServer = require("./mockEmailServer");

const PORT = process.env.PORT || 3000;
const ADVISOR_EMAIL = process.env.ADVISOR_EMAIL || "advisor@lionuniversity.edu";
const NOREPLY_EMAIL = "noreply@lionuniversity.edu";
const DB_DIR = path.join(__dirname, "Roster Info DB");
const LOG_DIR = path.join(__dirname, "logs");
const API_LOG_PATH = path.join(LOG_DIR, "api.log");
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || path.join(__dirname, "certs", "localhost-key.pem");
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || path.join(__dirname, "certs", "localhost-cert.pem");

const FILES = {
  studentRoster: path.join(DB_DIR, "studentRoster.json"),
  enrollments: path.join(DB_DIR, "student_course_inprogress.json"),
  academicStatuses: path.join(DB_DIR, "academicStatus.json"),
  fees: path.join(DB_DIR, "fee.json"),
  payments: path.join(DB_DIR, "payment.json"),
  programs: path.join(DB_DIR, "program.json"),
  courses: path.join(__dirname, "..", "Course Registration DB", "course.json"),
  courseSchedules: path.join(__dirname, "..", "Course Registration DB", "course_schedule.json"),
};

const FILE_TO_TABLE = {
  [FILES.studentRoster]: "studentRoster",
  [FILES.enrollments]: "student_course_inprogress",
  [FILES.academicStatuses]: "academicStatus",
  [FILES.fees]: "fee",
  [FILES.payments]: "payment",
  [FILES.programs]: "program",
  [FILES.courseSchedules]: "course_schedule",
};

function nowIso() {
  return new Date().toISOString();
}

function ensureLogDirectory() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function createRequestId() {
  if (typeof randomUUID === "function") {
    return randomUUID();
  }

  return `req-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function toTableName(filePath) {
  return FILE_TO_TABLE[filePath] || path.basename(filePath, ".json");
}

function logApiEvent(level, event, details = {}) {
  const entry = {
    timestamp: nowIso(),
    level,
    event,
    ...details,
  };

  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(API_LOG_PATH, line, "utf8");

  // eslint-disable-next-line no-console
  console.log(line.trim());
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function writeJson(filePath, data) {
  const serialized = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(filePath, serialized, "utf8");
}

function nextNumericSuffix(items, key, prefix, width) {
  let maxValue = 0;

  for (const item of items) {
    const value = String(item[key] || "");
    if (!value.startsWith(prefix)) {
      continue;
    }

    const numericPart = value.slice(prefix.length);
    const parsed = Number.parseInt(numericPart, 10);
    if (Number.isFinite(parsed)) {
      maxValue = Math.max(maxValue, parsed);
    }
  }

  const next = maxValue + 1;
  return prefix + String(next).padStart(width, "0");
}

function nextAcademicStatusId(items) {
  let maxValue = 0;

  for (const item of items) {
    const parsed = Number.parseInt(String(item.academicStatusID || ""), 10);
    if (Number.isFinite(parsed)) {
      maxValue = Math.max(maxValue, parsed);
    }
  }

  return String(maxValue + 1);
}

function nextEnrollmentId(items) {
  return nextNumericSuffix(items, "enrollmentId", "ENR", 3);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function buildApplicationSubmissionMessage(programName, studentId) {
  return `Your application for the ${programName} program has been submitted. Your student ID is ${studentId}.`;
}

function validateBody(body) {
  const allowedTopLevel = ["student", "programID"];
  const requiredTopLevel = ["student", "programID"];

  for (const key of requiredTopLevel) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) {
      return `Missing required field: ${key}`;
    }
  }

  const unknownTopLevel = Object.keys(body).filter((key) => !allowedTopLevel.includes(key));
  if (unknownTopLevel.length > 0) {
    return `Unsupported top-level fields: ${unknownTopLevel.join(", ")}`;
  }

  if (!body.student || typeof body.student !== "object" || Array.isArray(body.student)) {
    return "student must be an object";
  }

  if (!body.student.name) {
    return "student.name is required";
  }

  if (!body.student.emailAddress) {
    return "student.emailAddress is required";
  }

  if (!body.programID || typeof body.programID !== "string") {
    return "programID is required and must be a string";
  }

  return null;
}

function validateEnrollmentSelectionBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }

  if (!body.studentId || typeof body.studentId !== "string") {
    return "studentId is required and must be a string";
  }

  if (!Array.isArray(body.courseScheduleIds) || body.courseScheduleIds.length === 0) {
    return "courseScheduleIds is required and must be a non-empty array of strings";
  }

  const invalidItem = body.courseScheduleIds.find((item) => typeof item !== "string" || !item.trim());
  if (invalidItem !== undefined) {
    return "courseScheduleIds must contain non-empty string values";
  }

  return null;
}

function normalizeLegacyFieldKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function parseLegacyFieldMap(legacyText) {
  const fieldMap = {};
  const segments = String(legacyText || "")
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const separatorIndex = segment.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const rawKey = segment.slice(0, separatorIndex).trim();
    const rawValue = segment.slice(separatorIndex + 1).trim();
    const normalizedKey = normalizeLegacyFieldKey(rawKey);

    if (normalizedKey) {
      fieldMap[normalizedKey] = rawValue;
    }
  }

  return fieldMap;
}

function pickLegacyFieldValue(fieldMap, candidateKeys) {
  for (const key of candidateKeys) {
    const value = fieldMap[normalizeLegacyFieldKey(key)];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function createStudentBundleFromLegacyPayload(legacyText, options = {}) {
  const input = String(legacyText || "").trim();
  if (!input) {
    const error = new Error("Legacy payload is required.");
    error.statusCode = 400;
    throw error;
  }

  const fieldMap = parseLegacyFieldMap(input);
  if (Object.keys(fieldMap).length === 0) {
    const error = new Error("Legacy payload format is invalid. Expected key/value pairs separated by ';'.");
    error.statusCode = 400;
    throw error;
  }

  const configuredProgramID = typeof options.programID === "string" ? options.programID.trim() : "";
  const payloadProgramID = pickLegacyFieldValue(fieldMap, ["program id", "programID", "program"]);
  const defaultProgramID = String(process.env.LEGACY_PROGRAM_ID || "INSC").trim();
  const programID = configuredProgramID || payloadProgramID || defaultProgramID;

  const mappedBody = {
    student: {
      name: pickLegacyFieldValue(fieldMap, ["name"]),
      SSN: pickLegacyFieldValue(fieldMap, ["ssn"]),
      emailAddress: pickLegacyFieldValue(fieldMap, ["email", "email address", "emailAddress"]),
      homePhone: pickLegacyFieldValue(fieldMap, ["phone", "home phone", "homePhone"]),
      localAddr: pickLegacyFieldValue(fieldMap, ["local address", "localAddr"]),
      homeAddr: pickLegacyFieldValue(fieldMap, ["home address", "homeAddr", "address"]),
      emergencyContact: pickLegacyFieldValue(fieldMap, ["emergency contact", "emergencyContact"]),
    },
    programID,
  };

  return {
    mappedBody,
    legacyApplicantId: pickLegacyFieldValue(fieldMap, ["id", "student id", "applicant id"]),
    sourcePayload: input,
  };
}

function createStudentBundle(body) {
  const studentRosterFile = readJson(FILES.studentRoster);
  const academicStatusFile = readJson(FILES.academicStatuses);
  const programFile = readJson(FILES.programs);

  const students = Array.isArray(studentRosterFile.students) ? studentRosterFile.students : [];
  const academicStatuses = Array.isArray(academicStatusFile.academicStatuses) ? academicStatusFile.academicStatuses : [];
  const programs = Array.isArray(programFile.programs) ? programFile.programs : [];

  const duplicate = students.find(
    (s) => String(s.emailAddress || "").toLowerCase() === String(body.student.emailAddress).toLowerCase()
  );
  if (duplicate) {
    const error = new Error("A student with this emailAddress already exists");
    error.statusCode = 409;
    throw error;
  }

  const stuId = nextNumericSuffix(students, "stuId", "STU", 3);
  const academicStatusID = nextAcademicStatusId(academicStatuses);

  const programRecord = programs.find((program) => String(program.programID) === String(body.programID));
  if (!programRecord) {
    const error = new Error("Invalid programID. Program does not exist.");
    error.statusCode = 400;
    throw error;
  }

  const programID = programRecord.programID;

  const timestamp = nowIso();

  const studentRecord = {
    stuId,
    name: body.student.name,
    SSN: body.student.SSN || "",
    emailAddress: body.student.emailAddress,
    homePhone: body.student.homePhone || "",
    localAddr: body.student.localAddr || "",
    homeAddr: body.student.homeAddr || "",
    emergencyContact: body.student.emergencyContact || "",
    programID,
    paymentID: "",
    academicStatusID,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const academicStatusRecord = {
    academicStatusID,
    statusType: "applicant",
    remark: "Created from initial application submission",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  students.push(studentRecord);
  academicStatuses.push(academicStatusRecord);

  studentRosterFile.students = students;
  academicStatusFile.academicStatuses = academicStatuses;

  const originalText = {
    [FILES.studentRoster]: fs.readFileSync(FILES.studentRoster, "utf8"),
    [FILES.academicStatuses]: fs.readFileSync(FILES.academicStatuses, "utf8"),
  };

  const written = [];
  const targetTables = [toTableName(FILES.studentRoster), toTableName(FILES.academicStatuses)];
  try {
    writeJson(FILES.studentRoster, studentRosterFile);
    written.push(FILES.studentRoster);
    writeJson(FILES.academicStatuses, academicStatusFile);
    written.push(FILES.academicStatuses);
  } catch (error) {
    for (const filePath of written) {
      fs.writeFileSync(filePath, originalText[filePath], "utf8");
    }
    error.updatedTables = written.map(toTableName);
    error.targetTables = targetTables;
    throw error;
  }

  return {
    student: studentRecord,
    program: programRecord,
    academicStatus: academicStatusRecord,
    updatedTables: written.map(toTableName),
  };
}

function toPublicApplicationResponse(bundle) {
  return {
    application: {
      studentId: bundle.student.stuId,
      program: {
        programId: bundle.program.programID,
        programName: bundle.program.name,
      },
      statusType: bundle.academicStatus.statusType,
    },
  };
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function parseTextBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      resolve(String(raw || ""));
    });

    req.on("error", reject);
  });
}

function parseQuery(req) {
  const baseUrl = `https://${req.headers.host || "localhost"}`;
  const requestUrl = new URL(req.url || "/", baseUrl);
  return requestUrl.searchParams;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function isRegistrationEligible(statusType) {
  const normalizedStatus = normalizeText(statusType).toLowerCase();
  return normalizedStatus === "admitted" || normalizedStatus === "enrolled";
}

function getEnrollmentInfo(filters) {
  const studentRosterFile = readJson(FILES.studentRoster);
  const academicStatusFile = readJson(FILES.academicStatuses);
  const programFile = readJson(FILES.programs);
  const courseScheduleFile = readJson(FILES.courseSchedules);
  const courseFile = readJson(FILES.courses);

  const students = Array.isArray(studentRosterFile.students) ? studentRosterFile.students : [];
  const academicStatuses = Array.isArray(academicStatusFile.academicStatuses) ? academicStatusFile.academicStatuses : [];
  const programs = Array.isArray(programFile.programs) ? programFile.programs : [];
  const courseSchedules = Array.isArray(courseScheduleFile.courseSchedules) ? courseScheduleFile.courseSchedules : [];
  const courses = Array.isArray(courseFile.courses) ? courseFile.courses : [];

  const studentId = normalizeText(filters.studentId);
  const emailAddress = normalizeText(filters.emailAddress).toLowerCase();

  let student = null;

  if (studentId && emailAddress) {
    const byId = students.find((item) => normalizeText(item.stuId) === studentId) || null;
    const byEmail = students.find((item) => normalizeText(item.emailAddress).toLowerCase() === emailAddress) || null;

    if (!byId || !byEmail || normalizeText(byId.stuId) !== normalizeText(byEmail.stuId)) {
      const error = new Error("The provided studentId and emailAddress do not match the same student record.");
      error.statusCode = 401;
      throw error;
    }

    student = byId;
  } else if (studentId) {
    student = students.find((item) => normalizeText(item.stuId) === studentId) || null;
  } else if (emailAddress) {
    student = students.find((item) => normalizeText(item.emailAddress).toLowerCase() === emailAddress) || null;
  }

  if (!student) {
    const error = new Error("Student not found");
    error.statusCode = 404;
    throw error;
  }

  const program = programs.find((item) => normalizeText(item.programID) === normalizeText(student.programID)) || null;
  const academicStatus = academicStatuses.find(
    (item) => normalizeText(item.academicStatusID) === normalizeText(student.academicStatusID)
  ) || null;

  const availableCourses = courseSchedules
    .filter((schedule) => {
      if (schedule.availability === false) {
        return false;
      }

      const course = courses.find((item) => normalizeText(item.courseID) === normalizeText(schedule.courseID));
      if (!course || !program) {
        return false;
      }

      const courseProgramId = normalizeText(course.programID);
      if (courseProgramId) {
        return courseProgramId === normalizeText(program.programID);
      }

      const courseProgramIds = Array.isArray(course.programIDs) ? course.programIDs : [];
      if (courseProgramIds.length > 0) {
        return courseProgramIds.map((value) => normalizeText(value)).includes(normalizeText(program.programID));
      }

      return false;
    })
    .map((schedule) => {
      const course = courses.find((item) => normalizeText(item.courseID) === normalizeText(schedule.courseID)) || {};
      return {
        courseScheduleID: schedule.courseScheduleID,
        courseID: schedule.courseID,
        courseName: course.courseName,
        courseDescriptionUrl: `https://www.lionuniversity.com/course/${encodeURIComponent(schedule.courseID)}`,
        sectionNo: course.sectionNo,
        semester: schedule.semester,
        scheduleTime: schedule.scheduleTime,
        location: schedule.location,
        credits: course.credits,
        prerequisite: course.prerequisite,
        availability: schedule.availability,
        requiresAdvisorApproval: schedule.requiresAdvisorApproval === true,
      };
    });

  const statusType = academicStatus ? academicStatus.statusType : "unknown";

  return {
    student: {
      studentId: student.stuId,
      name: student.name,
      emailAddress: student.emailAddress,
    },
    acceptanceRecord: {
      statusType,
      canRegister: isRegistrationEligible(statusType),
    },
    program: program
      ? {
        programID: program.programID,
        name: program.name,
        department: program.department,
        college: program.college,
      }
      : null,
    availableCourses,
  };
}

function createEnrollmentSelections(body) {
  const enrollmentFile = readJson(FILES.enrollments);
  const studentRosterFile = readJson(FILES.studentRoster);
  const academicStatusFile = readJson(FILES.academicStatuses);
  const courseScheduleFile = readJson(FILES.courseSchedules);
  const courseFile = readJson(FILES.courses);
  const feeFile = readJson(FILES.fees);

  const enrollments = Array.isArray(enrollmentFile.enrollments) ? enrollmentFile.enrollments : [];
  const students = Array.isArray(studentRosterFile.students) ? studentRosterFile.students : [];
  const academicStatuses = Array.isArray(academicStatusFile.academicStatuses) ? academicStatusFile.academicStatuses : [];
  const courseSchedules = Array.isArray(courseScheduleFile.courseSchedules) ? courseScheduleFile.courseSchedules : [];
  const courses = Array.isArray(courseFile.courses) ? courseFile.courses : [];
  const fees = Array.isArray(feeFile.fees) ? feeFile.fees : [];

  const studentId = normalizeText(body.studentId);
  const student = students.find((item) => normalizeText(item.stuId) === studentId);
  if (!student) {
    const error = new Error("Student not found");
    error.statusCode = 404;
    throw error;
  }

  const academicStatus = academicStatuses.find(
    (item) => normalizeText(item.academicStatusID) === normalizeText(student.academicStatusID)
  ) || null;
  const statusType = academicStatus ? academicStatus.statusType : "unknown";
  if (!isRegistrationEligible(statusType)) {
    const error = new Error("Student is not eligible to register");
    error.statusCode = 400;
    throw error;
  }

  const normalizedRequestedIds = body.courseScheduleIds.map((item) => normalizeText(item));
  const distinctRequestedIds = [...new Set(normalizedRequestedIds)];
  if (distinctRequestedIds.length !== normalizedRequestedIds.length) {
    const error = new Error("Duplicate courseScheduleIds are not allowed");
    error.statusCode = 400;
    throw error;
  }

  const feeID = normalizeText(body.feeID) || normalizeText((fees[0] || {}).feeId);
  if (!feeID) {
    const error = new Error("No fee configuration available");
    error.statusCode = 500;
    throw error;
  }

  if (!fees.find((item) => normalizeText(item.feeId) === feeID)) {
    const error = new Error("Invalid feeID. Fee does not exist.");
    error.statusCode = 400;
    throw error;
  }

  const targetSchedules = distinctRequestedIds.map((scheduleId) => {
    const schedule = courseSchedules.find((item) => normalizeText(item.courseScheduleID) === scheduleId);
    if (!schedule) {
      const error = new Error(`Invalid courseScheduleId: ${scheduleId}`);
      error.statusCode = 400;
      throw error;
    }

    if (schedule.availability === false) {
      const error = new Error(`Course schedule is not available: ${scheduleId}`);
      error.statusCode = 400;
      throw error;
    }

    const capacity = Number(schedule.capacity || 0);
    const enrolledCount = Number(schedule.enrolledCount || 0);
    if (capacity > 0 && enrolledCount >= capacity) {
      const error = new Error(`Course schedule is full: ${scheduleId}`);
      error.statusCode = 400;
      throw error;
    }

    const alreadyEnrolled = enrollments.find(
      (item) => normalizeText(item.studentId) === studentId
        && normalizeText(item.courseScheduleId) === normalizeText(schedule.courseScheduleID)
    );
    if (alreadyEnrolled) {
      const error = new Error(`Student already enrolled in: ${scheduleId}`);
      error.statusCode = 409;
      throw error;
    }

    const course = courses.find((item) => normalizeText(item.courseID) === normalizeText(schedule.courseID));
    if (!course) {
      const error = new Error(`Course metadata not found for schedule: ${scheduleId}`);
      error.statusCode = 500;
      throw error;
    }

    if (normalizeText(course.programID) !== normalizeText(student.programID)) {
      const error = new Error(`Course schedule does not match student's program: ${scheduleId}`);
      error.statusCode = 400;
      throw error;
    }

    return {
      schedule,
      course,
    };
  });

  const timestamp = nowIso();
  const createdEnrollments = targetSchedules.map(({ schedule, course }) => {
    const enrollmentId = nextEnrollmentId(enrollments);
    const enrollmentRecord = {
      enrollmentId,
      studentId: student.stuId,
      courseScheduleId: schedule.courseScheduleID,
      credit: Number(course.credits || 0),
      feeID,
      status: schedule.requiresAdvisorApproval === true ? "Pending Advisor" : "Requested",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    enrollments.push(enrollmentRecord);

    const currentCount = Number(schedule.enrolledCount || 0);
    const nextCount = currentCount + 1;
    schedule.enrolledCount = nextCount;
    if (Number(schedule.capacity || 0) > 0) {
      schedule.availability = nextCount < Number(schedule.capacity);
    }
    schedule.updatedAt = timestamp;

    return enrollmentRecord;
  });

  enrollmentFile.enrollments = enrollments;
  courseScheduleFile.courseSchedules = courseSchedules;

  const originalText = {
    [FILES.enrollments]: fs.readFileSync(FILES.enrollments, "utf8"),
    [FILES.courseSchedules]: fs.readFileSync(FILES.courseSchedules, "utf8"),
  };

  const written = [];
  const targetTables = [toTableName(FILES.enrollments), toTableName(FILES.courseSchedules)];
  try {
    writeJson(FILES.enrollments, enrollmentFile);
    written.push(FILES.enrollments);
    writeJson(FILES.courseSchedules, courseScheduleFile);
    written.push(FILES.courseSchedules);
  } catch (error) {
    for (const filePath of written) {
      fs.writeFileSync(filePath, originalText[filePath], "utf8");
    }
    error.updatedTables = written.map(toTableName);
    error.targetTables = targetTables;
    throw error;
  }

  return {
    student: {
      studentId: student.stuId,
      name: student.name,
    },
    enrollments: createdEnrollments,
    updatedTables: written.map(toTableName),
  };
}

function admitStudent(body) {
  const studentRosterFile = readJson(FILES.studentRoster);
  const academicStatusFile = readJson(FILES.academicStatuses);

  const students = Array.isArray(studentRosterFile.students) ? studentRosterFile.students : [];
  const academicStatuses = Array.isArray(academicStatusFile.academicStatuses) ? academicStatusFile.academicStatuses : [];

  const studentId = normalizeText(body.studentId);
  const student = students.find((item) => normalizeText(item.stuId) === studentId);
  if (!student) {
    const error = new Error("Student not found");
    error.statusCode = 404;
    throw error;
  }

  const academicStatus = academicStatuses.find(
    (item) => normalizeText(item.academicStatusID) === normalizeText(student.academicStatusID)
  );
  if (!academicStatus) {
    const error = new Error("Academic status record not found for student");
    error.statusCode = 500;
    throw error;
  }

  if (normalizeText(academicStatus.statusType).toLowerCase() !== "applicant") {
    const error = new Error(`Student status is '${academicStatus.statusType}', must be 'applicant' to admit`);
    error.statusCode = 409;
    throw error;
  }

  const timestamp = nowIso();
  academicStatus.statusType = "admitted";
  academicStatus.remark = "Admitted by advisor";
  academicStatus.updatedAt = timestamp;
  student.updatedAt = timestamp;

  academicStatusFile.academicStatuses = academicStatuses;
  studentRosterFile.students = students;

  const originalText = {
    [FILES.academicStatuses]: fs.readFileSync(FILES.academicStatuses, "utf8"),
    [FILES.studentRoster]: fs.readFileSync(FILES.studentRoster, "utf8"),
  };

  const written = [];
  const targetTables = [toTableName(FILES.academicStatuses), toTableName(FILES.studentRoster)];
  try {
    writeJson(FILES.academicStatuses, academicStatusFile);
    written.push(FILES.academicStatuses);
    writeJson(FILES.studentRoster, studentRosterFile);
    written.push(FILES.studentRoster);
  } catch (error) {
    for (const filePath of written) {
      fs.writeFileSync(filePath, originalText[filePath], "utf8");
    }
    error.updatedTables = written.map(toTableName);
    error.targetTables = targetTables;
    throw error;
  }

  return {
    student: {
      studentId: student.stuId,
      name: student.name,
    },
    academicStatus: {
      academicStatusID: academicStatus.academicStatusID,
      statusType: academicStatus.statusType,
      remark: academicStatus.remark,
      updatedAt: academicStatus.updatedAt,
    },
    updatedTables: written.map(toTableName),
  };
}

const APPROVE_COURSE_DECISIONS = {
  approve: "Registered",
  pending_instructor: "Pending Instructor",
};

function approveCourseEnrollment(body) {
  const enrollmentFile = readJson(FILES.enrollments);
  const enrollments = Array.isArray(enrollmentFile.enrollments) ? enrollmentFile.enrollments : [];

  const enrollmentId = normalizeText(body.enrollmentId);
  const enrollment = enrollments.find((item) => normalizeText(item.enrollmentId) === enrollmentId);
  if (!enrollment) {
    const error = new Error("Enrollment not found");
    error.statusCode = 404;
    throw error;
  }

  if (normalizeText(enrollment.status) !== "Pending Advisor") {
    const error = new Error(`Enrollment status is '${enrollment.status}', must be 'Pending Advisor' to approve`);
    error.statusCode = 409;
    throw error;
  }

  const decision = normalizeText(body.decision).toLowerCase();
  const newStatus = APPROVE_COURSE_DECISIONS[decision];
  if (!newStatus) {
    const error = new Error(`Invalid decision '${body.decision}'. Must be 'approve' or 'pending_instructor'`);
    error.statusCode = 400;
    throw error;
  }

  const timestamp = nowIso();
  enrollment.status = newStatus;
  enrollment.updatedAt = timestamp;

  enrollmentFile.enrollments = enrollments;

  const originalText = {
    [FILES.enrollments]: fs.readFileSync(FILES.enrollments, "utf8"),
  };

  const written = [];
  const targetTables = [toTableName(FILES.enrollments)];
  try {
    writeJson(FILES.enrollments, enrollmentFile);
    written.push(FILES.enrollments);
  } catch (error) {
    for (const filePath of written) {
      fs.writeFileSync(filePath, originalText[filePath], "utf8");
    }
    error.updatedTables = written.map(toTableName);
    error.targetTables = targetTables;
    throw error;
  }

  return {
    enrollment: {
      enrollmentId: enrollment.enrollmentId,
      studentId: enrollment.studentId,
      courseScheduleId: enrollment.courseScheduleId,
      status: enrollment.status,
      updatedAt: enrollment.updatedAt,
    },
    updatedTables: written.map(toTableName),
  };
}

function loadHttpsOptions() {
  if (!fs.existsSync(TLS_KEY_PATH)) {
    throw new Error(`TLS private key file not found: ${TLS_KEY_PATH}`);
  }

  if (!fs.existsSync(TLS_CERT_PATH)) {
    throw new Error(`TLS certificate file not found: ${TLS_CERT_PATH}`);
  }

  return {
    key: fs.readFileSync(TLS_KEY_PATH, "utf8"),
    cert: fs.readFileSync(TLS_CERT_PATH, "utf8"),
  };
}

const httpsOptions = loadHttpsOptions();
ensureLogDirectory();

const server = https.createServer(httpsOptions, async (req, res) => {
  const requestId = createRequestId();
  const startedAt = Date.now();
  const routePath = String(req.url || "").split("?")[0];

  const requestMeta = {
    requestId,
    method: req.method,
    path: routePath,
    remoteAddress: req.socket.remoteAddress || "unknown",
  };

  logApiEvent("info", "request.received", requestMeta);

  const respond = (statusCode, payload, details = {}) => {
    sendJson(res, statusCode, payload);
    logApiEvent("info", "request.completed", {
      ...requestMeta,
      statusCode,
      durationMs: Date.now() - startedAt,
      updatedTables: Array.isArray(details.updatedTables) ? details.updatedTables : [],
      error: details.error,
    });
  };

  if (req.method === "OPTIONS") {
    respond(204, {});
    return;
  }

  if (req.method === "GET" && routePath === "/health") {
    respond(200, {
      message: "Roster API is available.",
      status: "ok",
    });
    return;
  }

  if (req.method === "GET" && routePath === "/api/enrollment-info") {
    try {
      const query = parseQuery(req);
      const studentId = normalizeText(query.get("studentId"));
      const emailAddress = normalizeText(query.get("emailAddress"));

      if (!studentId && !emailAddress) {
        respond(400, {
          message: "studentId or emailAddress query parameter is required.",
          error: "Missing required query parameter",
        });
        return;
      }

      const enrollmentInfo = getEnrollmentInfo({
        studentId,
        emailAddress,
      });

      respond(200, {
        message: "Enrollment info retrieved successfully.",
        data: enrollmentInfo,
      });
      return;
    } catch (error) {
      respond(error.statusCode || 500, {
        message: "We could not retrieve enrollment information right now.",
        error: error.message || "Unexpected error",
      }, {
        error: {
          message: error.message || "Unexpected error",
        },
      });
      return;
    }
  }

  if (req.method === "POST" && routePath === "/api/public/students") {
    try {
      const body = await parseJsonBody(req);
      const validationError = validateBody(body);
      if (validationError) {
        respond(400, {
          message: "We could not submit your application. Please review the form and try again.",
          error: validationError,
        });
        return;
      }

      const result = createStudentBundle(body);
      respond(201, {
        message: buildApplicationSubmissionMessage(result.program.name, result.student.stuId),
        data: toPublicApplicationResponse(result),
      }, {
        updatedTables: result.updatedTables,
      });
      return;
    } catch (error) {
      const statusCode = error.statusCode || 500;
      respond(statusCode, {
        message: "We could not process your request right now. Please try again.",
        error: error.message || "Unexpected error",
      }, {
        updatedTables: Array.isArray(error.updatedTables) ? error.updatedTables : [],
        error: {
          message: error.message || "Unexpected error",
          targetTables: Array.isArray(error.targetTables) ? error.targetTables : [],
        },
      });
      return;
    }
  }

  if (req.method === "POST" && routePath === "/api/public/students/legacy") {
    try {
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      let legacyPayload = "";
      let programID = "";

      if (contentType.includes("application/json")) {
        const body = await parseJsonBody(req);
        legacyPayload = String(body.legacyPayload || body.application || body.payload || "");
        programID = String(body.programID || "").trim();
      } else {
        legacyPayload = await parseTextBody(req);
      }

      const adapted = createStudentBundleFromLegacyPayload(legacyPayload, { programID });
      const validationError = validateBody(adapted.mappedBody);
      if (validationError) {
        respond(400, {
          message: "We could not submit your legacy application. Please review the format and try again.",
          error: validationError,
          expectedFormat: "Name: Bob Smith; ID: 1111; Home Address: 123 Main St; Email: bob@example.com; Phone: 111-222-3333",
        });
        return;
      }

      const result = createStudentBundle(adapted.mappedBody);
      respond(201, {
        message: buildApplicationSubmissionMessage(result.program.name, result.student.stuId),
        data: {
          ...toPublicApplicationResponse(result),
          adapter: {
            source: "legacy-client",
            legacyApplicantId: adapted.legacyApplicantId,
          },
        },
      }, {
        updatedTables: result.updatedTables,
      });
      return;
    } catch (error) {
      const statusCode = error.statusCode || 500;
      respond(statusCode, {
        message: "We could not process the legacy application right now.",
        error: error.message || "Unexpected error",
      }, {
        updatedTables: Array.isArray(error.updatedTables) ? error.updatedTables : [],
        error: {
          message: error.message || "Unexpected error",
          targetTables: Array.isArray(error.targetTables) ? error.targetTables : [],
        },
      });
      return;
    }
  }

  if (req.method === "POST" && routePath === "/api/enrollments") {
    try {
      const body = await parseJsonBody(req);
      const validationError = validateEnrollmentSelectionBody(body);
      if (validationError) {
        respond(400, {
          message: "We could not submit enrollment selections. Please review and try again.",
          error: validationError,
        });
        return;
      }

      const result = createEnrollmentSelections(body);

      const pendingAdvisor = result.enrollments.filter((e) => e.status === "Pending Advisor");
      for (const enrollment of pendingAdvisor) {
        notificationQueue.enqueue({
          to: ADVISOR_EMAIL,
          from: NOREPLY_EMAIL,
          subject: `Action Required: Course Enrollment Approval – ${result.student.name}`,
          body: [
            `Student ${result.student.name} (${enrollment.studentId}) has submitted an enrollment`,
            `request for course schedule ${enrollment.courseScheduleId}, which requires advisor approval.`,
            ``,
            `Enrollment ID : ${enrollment.enrollmentId}`,
            `Credits       : ${enrollment.credit}`,
            `Status        : ${enrollment.status}`,
            ``,
            `Please log in and review the enrollment to approve or return it for instructor review.`,
          ].join("\n"),
          metadata: {
            enrollmentId: enrollment.enrollmentId,
            studentId: enrollment.studentId,
            courseScheduleId: enrollment.courseScheduleId,
          },
        });
      }

      const { updatedTables: enrollmentTables, ...enrollmentData } = result;
      respond(201, {
        message: "Enrollment selections submitted successfully.",
        data: enrollmentData,
      }, {
        updatedTables: enrollmentTables,
      });
      return;
    } catch (error) {
      const statusCode = error.statusCode || 500;
      respond(statusCode, {
        message: "We could not process enrollment selections right now.",
        error: error.message || "Unexpected error",
      }, {
        updatedTables: Array.isArray(error.updatedTables) ? error.updatedTables : [],
        error: {
          message: error.message || "Unexpected error",
          targetTables: Array.isArray(error.targetTables) ? error.targetTables : [],
        },
      });
      return;
    }
  }

  if (req.method === "POST" && routePath === "/api/students/admit") {
    try {
      const body = await parseJsonBody(req);
      if (!normalizeText(body.studentId)) {
        respond(400, {
          message: "studentId is required.",
          error: "Missing required field: studentId",
        });
        return;
      }

      const result = admitStudent(body);
      const { updatedTables: admitTables, ...admitData } = result;
      respond(200, {
        message: `Student ${result.student.name} has been admitted successfully.`,
        data: admitData,
      }, {
        updatedTables: admitTables,
      });
      return;
    } catch (error) {
      const statusCode = error.statusCode || 500;
      respond(statusCode, {
        message: "We could not admit the student right now.",
        error: error.message || "Unexpected error",
      }, {
        updatedTables: Array.isArray(error.updatedTables) ? error.updatedTables : [],
        error: {
          message: error.message || "Unexpected error",
          targetTables: Array.isArray(error.targetTables) ? error.targetTables : [],
        },
      });
      return;
    }
  }

  if (req.method === "POST" && routePath === "/api/enrollments/approve-course") {
    try {
      const body = await parseJsonBody(req);
      if (!normalizeText(body.enrollmentId)) {
        respond(400, {
          message: "enrollmentId is required.",
          error: "Missing required field: enrollmentId",
        });
        return;
      }
      if (!normalizeText(body.decision)) {
        respond(400, {
          message: "decision is required. Must be 'approve' or 'pending_instructor'.",
          error: "Missing required field: decision",
        });
        return;
      }

      const result = approveCourseEnrollment(body);
      const { updatedTables: approveTables, ...approveData } = result;
      respond(200, {
        message: `Enrollment ${result.enrollment.enrollmentId} updated to '${result.enrollment.status}'.`,
        data: approveData,
      }, {
        updatedTables: approveTables,
      });
      return;
    } catch (error) {
      const statusCode = error.statusCode || 500;
      respond(statusCode, {
        message: "We could not process the course approval right now.",
        error: error.message || "Unexpected error",
      }, {
        updatedTables: Array.isArray(error.updatedTables) ? error.updatedTables : [],
        error: {
          message: error.message || "Unexpected error",
          targetTables: Array.isArray(error.targetTables) ? error.targetTables : [],
        },
      });
      return;
    }
  }

  if (req.method === "GET" && routePath === "/api/notifications/queue") {
    respond(200, {
      message: "Notification queue retrieved.",
      data: notificationQueue.getQueue(),
    });
    return;
  }

  if (req.method === "GET" && routePath === "/api/notifications/mailbox") {
    const MAILBOX_FILE = path.join(__dirname, "Notification Queue", "mailbox.json");
    let mailboxData = { emails: [] };
    if (fs.existsSync(MAILBOX_FILE)) {
      try {
        mailboxData = JSON.parse(fs.readFileSync(MAILBOX_FILE, "utf8"));
      } catch { /* file unreadable — return empty */ }
    }
    respond(200, {
      message: "Advisor mailbox retrieved.",
      data: mailboxData,
    });
    return;
  }

  respond(404, {
    message: "The requested endpoint was not found.",
    error: "Route not found",
    availableRoutes: [
      "GET /health",
      "POST /api/public/students",
      "POST /api/public/students/legacy",
      "GET /api/enrollment-info",
      "POST /api/enrollments",
      "POST /api/students/admit",
      "POST /api/enrollments/approve-course",
      "GET /api/notifications/queue",
      "GET /api/notifications/mailbox",
    ],
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Roster API server listening on https://localhost:${PORT}`);
  mockEmailServer.start();
  notificationQueue.startWorker();
});
