# insc568finalproject
Depends on the needs in your design/implementation, the provided 2 database schemas can be adjusted if necessary. If you would like to implement the project, no connection to real database is needed (i.e., optional). The needed data can be simply hard coded in your APIs.    

    Task 1. Based on the provided project information, design those stated remote APIs (4 in total).
        a. Detailed data should be included in each of those 4 APIs. 
            i. Input 
            ii. Output
        b. How will you implement them? You can actually implement them using any programming language. Or simply you write it up using pseudo codes as you did in Exercise 1.  
    Task 2. Can you implement those 4 APIs at the method-level or the data-level? Or some of them should be implemented at the data-level or the method-level? Why or why not?
        a. Get the list of selected courses from Course System,
        b. Retrieve relevant courses information from Course System, 
        c. Update Course System with the selected courses information, 
        d. Update Roster System with the selected courses information.
    Task 3. Discussions
        a. Should an ESB be adopted in this project, in the short term or in the long run?  Why or why not?
        b. The benefits of adopting BPM in this project.


![img.png](img.png)

![img_1.png](img_1.png)

## Public Student Creation API

A single public API endpoint is implemented at:

- `POST /api/public/students`

It creates a new student bundle by writing records to all Roster Server Services JSON tables:

- `studentRoster.json`
- `program.json`
- `academicStatus.json`
- `fee.json`
- `payment.json`
- `student_course_inprogress.json`

### Run the API server

From the repository root:

```bash
set TLS_KEY_PATH=Roster Server Services\\certs\\localhost-key.pem
set TLS_CERT_PATH=Roster Server Services\\certs\\localhost-cert.pem
node "Roster Server Services/server.js"
```

Create the `Roster Server Services/certs` directory and provide your TLS key/cert files. You can also set absolute paths in `TLS_KEY_PATH` and `TLS_CERT_PATH`.

Default base URL:

- `https://localhost:3000`

Health check:

- `GET /health`

### Request body example

```json
{
    "student": {
        "name": "Jane Doe",
        "SSN": "",
        "emailAddress": "jane.doe@psu.edu",
        "homePhone": "",
        "localAddr": "",
        "homeAddr": "",
        "emergencyContact": ""
    },
    "program": {
        "programID": "",
        "name": "Information Systems",
        "department": "Engineering",
        "college": "Engineering"
    },
    "academicStatus": {
        "statusType": "admitted",
        "remark": ""
    },
    "fee": {
        "feePerCredit": 500,
        "specialRate": 0
    },
    "payment": {
        "startingBalance": 1500,
        "status": "pending",
        "remainingBalance": 1500
    },
    "enrollment": {
        "courseScheduleId": "INSC 568 F2026",
        "credit": 3
    }
}
```

### cURL example

```bash
curl -k -X POST https://localhost:3000/api/public/students \
    -H "Content-Type: application/json" \
    -d @payload.json
```

### Notes

- IDs are generated automatically when omitted (`STU###`, `ENR###`, `FEE###`, `PAY###`, `academicStatusID`, `PRG###`).
- If `program.programID` is provided in the request, that value is used.
- Duplicate `student.emailAddress` is rejected with HTTP `409`.

### OpenAPI (Swagger) Documentation

- OpenAPI spec file: `Roster Server Services/openapi.yaml`
- OpenAPI version: `3.1.1`

You can import this YAML file directly into Insomnia, Swagger Editor, or Swagger UI tooling.