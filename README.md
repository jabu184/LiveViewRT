LiveViewRT – Radiotherapy Machine Management Dashboard
LiveViewRT is a real-time, web-based dashboard designed to track the operational status, faults, and utilisation of radiotherapy treatment machines. It provides an at-a-glance view of the entire department while maintaining detailed audit trails and downtime metrics.

<img width="2516" height="1242" alt="image" src="https://github.com/user-attachments/assets/a4be13fd-3618-4b96-8c03-e494a0d4bcb5" />

<img width="2529" height="1325" alt="image" src="https://github.com/user-attachments/assets/5c0e1454-3316-4db3-a560-4f4cca58c3fb" />
<img width="2529" height="1325" alt="image" src="https://github.com/user-attachments/assets/5c0e1454-3316-4db3-a560-4f4cca58c3fb" />

<img width="2534" height="1309" alt="image" src="https://github.com/user-attachments/assets/87d42d81-b9f0-4642-8b61-8ee9d466ca22" />
<img width="2534" height="1309" alt="image" src="https://github.com/user-attachments/assets/87d42d81-b9f0-4642-8b61-8ee9d466ca22" />



🌟 Key Features
Real-Time Status Dashboard: Live overview of all treatment units showing their current clinical status (Clinical, QA, Service, Breakdown, Offline) and power state. Updates instantly across all screens without refreshing.
Fault & Breakdown Management: Easily report faults, classify their severity and category, and track open issues. When a machine breaks down, the system automatically tracks the downtime duration.
Smart Downtime Calculation: Automatically calculates breakdown downtime restricted to your department's configurable clinical core hours (e.g., Mon-Fri, 07:00 - 20:00).
Concessions & Restrictions: Record and monitor temporary clinical restrictions or concessions (e.g., "No electrons") with optional review dates.
Activity & Audit Logging: Comprehensive, searchable logs of all machine activities, power toggles, and status changes, complete with the user's name and role.
Reporting & Analytics: Dedicated Admin/Reports page featuring downtime analysis, active tracking vs. clinical utilisation percentages, historical fault logs, interactive monthly graphs, and CSV data export.
System Administration: Easily add or edit machines, customize fault categories/severities, set clinical hours, and manage one-click database backups directly from the browser.
Local Station Pinning: Users can set a "Default Station" on their local PC, automatically opening to their specific machine's detailed view when they load the app.
📖 Basic Instructions
1. Navigating the Dashboard
Status Banner: The top bar shows a quick pill-shaped overview of all active machines. A colored dot indicates their status (Green = Clinical, Red = Breakdown, etc.).
Overview Page: Displays a grid of cards for each machine showing its estimated 30-day uptime, active concessions, open faults, and recent breakdowns.
Recent Activity: A live-updating table at the bottom of the overview shows the latest logs across the entire department.
2. Managing a Specific Machine
Click on any machine card (or pill in the top banner) to open its detailed control page.

Changing Power/Status: Use the toggle switch to mark the machine's power ON or OFF. Click the status pills (Clinical, QA/Physics, Service, Offline) to change the current operational state. You will be prompted to enter your name to confirm the change.
Activity Log Tab: Click "+ Entry" to manually log a daily QA check, treatment session, or general note.
Faults Tab: View all historical faults for this specific machine.
3. Reporting and Resolving Faults
Reporting: Click the red "Report Fault" button on a machine's page. Select your role, the fault category, severity, and provide a description. If the fault prevents treatment, you can immediately change the machine status to "Breakdown" from this menu.
Acknowledging: Once a fault is addressed, click "Acknowledge" on the open fault to close it out.
Resolving Breakdowns: If a machine is in a Breakdown state, a green "Mark Breakdown As Resolved" button will appear. Clicking this allows you to review the automatically calculated downtime, override it if necessary, and return the machine to Clinical or QA status.
4. Adding Concessions
If a machine is safe to use but has limitations, click "+ Concession / Restriction". Enter the details and an optional review date. This will place a persistent warning banner on the machine's card until it is manually removed.

5. Setting a Default Station
If a computer is physically located at a specific treatment console (e.g., LA1), click "Set Station" in the top right corner of the header. Select that machine. Now, whenever the dashboard is opened on that specific computer, it will skip the overview and go straight to that machine's controls.

6. Using the Admin & Reports Page
Click "Admin / Reports" in the top navigation bar. (Note: This may require a password if enabled in the settings).

Date Range: Use the dropdown at the top to filter data (Last 7 Days, Last 30 Days, Last 12 Months, All Time).
Export Data: Click "Export CSV" to download the currently filtered logs and faults for use in Excel.
Tabs: Navigate through the tabs to view the detailed Fault Log, Downtime Metrics, Utilisation Graphs, the full System Audit Trail, or System Settings.
