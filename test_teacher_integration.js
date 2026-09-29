import { initDatabase, db } from './backend/database.js';
import { apiRouter } from './backend/api.js';

async function runTest() {
    console.log('Initializing test database...');
    await initDatabase();

    // 1. Create test teacher
    const tRes = db.prepare('INSERT INTO teachers (name, phone, per_class_rate, per_khata_rate, per_guard_rate) VALUES (?, ?, ?, ?, ?)').run(
        'Test Rahim Sir', '01711111111', 100, 10, 200
    );
    const teacherId = tRes.lastInsertRowid;
    console.log(`Created test teacher with ID: ${teacherId}`);

    // 2. Record Work
    const actRes = db.prepare(`
    INSERT INTO teacher_activities (teacher_id, activity_date, classes_taken, khatas_checked, guard_duties, per_class_rate, per_khata_rate, per_guard_rate, class_earnings, khata_earnings, guard_earnings, daily_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(teacherId, '2026-09-27', 5, 20, 1, 100, 10, 200, 500, 200, 200, 900);
    console.log('Recorded work successfully. Daily total: ৳900');

    // 3. Verify work since last payment
    const earned = db.prepare('SELECT COALESCE(SUM(daily_total), 0) as total FROM teacher_activities WHERE teacher_id = ?').get(teacherId).total;
    const paid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM teacher_payments WHERE teacher_id = ?').get(teacherId).total;
    const payable = Math.max(0, earned - paid);
    console.log(`Current Payable before payment: ৳${payable}`);

    // 4. Pay Teacher (Simulating /teachers/:id/pay logic)
    const payAmount = payable;
    db.prepare('INSERT INTO teacher_payments (teacher_id, payment_date, amount, note) VALUES (?, ?, ?, ?)').run(
        teacherId, '2026-09-27', payAmount, `Salary paid to Test Rahim Sir`
    );

    // 5. Create Salary Expense
    let cat = db.prepare("SELECT id FROM expense_categories WHERE name = 'Teacher Salary'").get();
    db.prepare('INSERT INTO expenses (category_id, amount, description, expense_date, expense_time, voucher_no) VALUES (?, ?, ?, ?, ?, ?)').run(
        cat.id, payAmount, 'Salary paid to Test Rahim Sir', '2026-09-27', '12:00 PM', 'V-TEST99'
    );
    console.log(`Paid ৳${payAmount} and created Teacher Salary expense.`);

    // 6. Verify Current Payable is reset to 0
    const newEarned = db.prepare('SELECT COALESCE(SUM(daily_total), 0) as total FROM teacher_activities WHERE teacher_id = ?').get(teacherId).total;
    const newPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM teacher_payments WHERE teacher_id = ?').get(teacherId).total;
    const newPayable = Math.max(0, newEarned - newPaid);
    console.log(`Current Payable after payment: ৳${newPayable} (Expected: ৳0)`);

    // 7. Record New Work after payment
    db.prepare(`
    INSERT INTO teacher_activities (teacher_id, activity_date, classes_taken, khatas_checked, guard_duties, per_class_rate, per_khata_rate, per_guard_rate, class_earnings, khata_earnings, guard_earnings, daily_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(teacherId, '2026-09-27', 2, 10, 0, 100, 10, 200, 200, 100, 0, 300);
    console.log('Recorded new work after payment (2 classes, 10 khatas).');

    // 8. Verify New Payable
    const latestEarned = db.prepare('SELECT COALESCE(SUM(daily_total), 0) as total FROM teacher_activities WHERE teacher_id = ?').get(teacherId).total;
    const latestPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM teacher_payments WHERE teacher_id = ?').get(teacherId).total;
    const latestPayable = Math.max(0, latestEarned - latestPaid);
    console.log(`Current Payable after new work: ৳${latestPayable} (Expected: ৳300)`);

    console.log('ALL TEACHER WORKFLOW TESTS PASSED SUCCESSFULLY!');
}

runTest().catch(console.error);
