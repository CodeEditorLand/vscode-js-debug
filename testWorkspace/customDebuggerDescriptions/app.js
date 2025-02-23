"use strict";
function customDebuggerDescription(obj, defaultValue) {
	if (obj.constructor && obj.constructor.prototype === obj) {
		// object is a prototype
		if (obj.constructor.name) {
			return `Prototype of ${obj.constructor.name}`;
		} else {
			return defaultValue;
		}
	} else if (
		obj.customDescription &&
		obj.customDescription instanceof Function
	) {
		return obj.customDescription();
	} else if (defaultValue.startsWith("class ")) {
		// just print class name without the constructor source code
		const className = defaultValue.split(" ", 2)[1];
		return `class ${className}`;
	} else {
		return defaultValue;
	}
}
global.customDebuggerDescription = customDebuggerDescription;
function customPropertiesGenerator(obj) {
	if (
		obj &&
		obj.customPropertiesGenerator &&
		obj.customPropertiesGenerator instanceof Function
	) {
		return obj.customPropertiesGenerator();
	} else {
		return obj;
	}
}
global.customPropertiesGenerator = customPropertiesGenerator;
class Fraction {
	constructor(numerator, denominator) {
		this.numerator = numerator;
		this.denominator = denominator;
	}
	customDescription() {
		return `${this.numerator}/${this.denominator}`;
	}
	floatValue() {
		return this.numerator / this.denominator;
	}
	customPropertiesGenerator() {
		const properties = Object.create(this.__proto__);
		Object.assign(
			properties,
			Object.assign(Object.assign({}, this), {
				asRational: this.floatValue(),
			}),
		);
		return properties;
	}
}
const fraction1 = new Fraction(2, 3);
const fraction2 = new Fraction(3, 4);
const fraction3 = new Fraction(5, 6);
console.log("Line 1");
console.log("Line 2");
console.log("Line 3");
console.log("Line 4");
console.log("Line 5");
console.log("Line 6");
console.log("Line 7");
console.log("Line 8");
//# sourceMappingURL=app.js.map
